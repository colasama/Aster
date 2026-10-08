use aster_render_ir::{
    BufferResourceDescriptor, ContractLevel, DecodeLimits, ElementType, FplnCodec, IrFixture,
    OwnedFpln, PlanSlice, PrecompositionGeneratorExecution, PrecompositionGeneratorRecord,
    PutResource, ResourceDescriptor, ResourceHash, ResourceKind, ResourceRegistry,
    RootCommandRecord, RootSceneCommandsSlice,
};

use crate::generator_input::GeneratorInput;

struct GeneratorFixture {
    root: OwnedFpln,
    records: Vec<PrecompositionGeneratorRecord>,
    registry: ResourceRegistry,
}

impl GeneratorFixture {
    fn register(
        registry: &mut ResourceRegistry,
        bytes: Vec<u8>,
    ) -> Result<ResourceHash, Box<dyn std::error::Error>> {
        let descriptor = BufferResourceDescriptor {
            element_type: ElementType::U8,
            element_count: bytes.len() as u32,
            byte_length: bytes.len() as u32,
        };
        let hash = ResourceHash::for_buffer(&descriptor, &bytes)?;
        registry.put(
            PutResource {
                hash: hash.clone(),
                kind: ResourceKind::Buffer,
                descriptor: ResourceDescriptor::Buffer(descriptor),
            },
            bytes,
        )?;
        Ok(hash)
    }

    fn new(source: Vec<u8>) -> Result<Self, Box<dyn std::error::Error>> {
        let limits = DecodeLimits::default();
        let (mut metadata, blobs) = IrFixture::parts()?;
        let mut root = FplnCodec::decode(
            FplnCodec::encode(
                metadata.clone(),
                &blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                &limits,
            )?,
            &limits,
        )?;
        let PlanSlice::SceneGenerator(mut invocation) = serde_json::from_str(include_str!(
            "../../../tests/parity/native-generator/invocation.json"
        ))?
        else {
            return Err("fixture invocation missing".into());
        };
        let mut registry = ResourceRegistry::new(Default::default())?;
        let shader = Self::register(&mut registry, source)?;
        for pass in &mut invocation.program.graph.compute_passes {
            pass.shader = shader.clone();
        }
        for variant in &mut invocation.program.graph.render_variants {
            variant.shader = shader.clone();
            variant.auxiliary = None;
        }
        let mut payload = vec![0; 2272];
        payload[24..28].copy_from_slice(&invocation.effective_count.to_le_bytes());
        payload[2256..2260].copy_from_slice(&6_u32.to_le_bytes());
        invocation.blob_index = 0;
        metadata.contract_level = ContractLevel::SceneGeneratorSliceV1;
        metadata.resources = vec![shader];
        metadata.blobs.truncate(1);
        metadata.blobs[0].byte_length = 2272;
        metadata.blobs[0].element_count = 2272;
        metadata.blobs[0].element_type = ElementType::U8;
        metadata.slices = vec![PlanSlice::SceneGenerator(invocation.clone())];
        let plan = Self::register(
            &mut registry,
            FplnCodec::encode(metadata, &[&payload], &limits)?,
        )?;
        root.metadata.slices = vec![PlanSlice::RootSceneCommands(RootSceneCommandsSlice {
            blob_index: 0,
            draws: vec![],
            commands: vec![RootCommandRecord::Generator {
                instance_id: invocation.instance_id.clone(),
                blend_mode: invocation.blend_mode,
            }],
        })];
        let records = vec![PrecompositionGeneratorRecord {
            instance_id: invocation.instance_id,
            plan,
            layer_name_utf16: vec![],
            plugin_id_utf16: vec![],
            execution: PrecompositionGeneratorExecution::Ready {
                capacity: invocation.capacity,
                effective_count: invocation.effective_count,
            },
        }];
        Ok(Self {
            root,
            records,
            registry,
        })
    }

    fn append_audio(&mut self, name: &str, value: u8) -> Result<(), Box<dyn std::error::Error>> {
        let limits = DecodeLimits::default();
        let mut plan = FplnCodec::decode(
            self.registry.resolve(&self.records[0].plan)?.to_vec(),
            &limits,
        )?;
        let mut payload = plan.blob(0)?.to_vec();
        payload.resize(11552, value);
        let Some(PlanSlice::SceneGenerator(invocation)) = plan.metadata.slices.first_mut() else {
            return Err("invocation absent".into());
        };
        invocation.instance_id = aster_render_ir::CompositionIdentity::Unicode(name.to_owned());
        invocation.has_audio = true;
        invocation.program.audio_analysis = true;
        let instance_id = invocation.instance_id.clone();
        let blend_mode = invocation.blend_mode.clone();
        plan.metadata.blobs[0].byte_length = payload.len() as u32;
        plan.metadata.blobs[0].element_count = payload.len() as u32;
        let hash = Self::register(
            &mut self.registry,
            FplnCodec::encode(plan.metadata, &[&payload], &limits)?,
        )?;
        self.records.push(PrecompositionGeneratorRecord {
            instance_id: instance_id.clone(),
            plan: hash,
            ..self.records[0].clone()
        });
        let Some(PlanSlice::RootSceneCommands(root)) = self.root.metadata.slices.first_mut() else {
            return Err("root absent".into());
        };
        root.commands.push(RootCommandRecord::Generator {
            instance_id,
            blend_mode,
        });
        Ok(())
    }
}

#[test]
fn supplied_audio_is_shared_and_conflicting_frame_records_are_rejected()
-> Result<(), Box<dyn std::error::Error>> {
    let limits = DecodeLimits::default();
    let mut fixture = GeneratorFixture::new(b"shader source".to_vec())?;
    fixture.append_audio("audio-first", 7)?;
    fixture.append_audio("audio-second", 7)?;
    let inputs =
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)?;
    let first = inputs
        .values()
        .next()
        .and_then(|input| input.audio.as_ref())
        .ok_or("audio absent")?;
    assert_eq!(first.as_ref(), vec![7; 9280]);
    assert_eq!(inputs.len(), 3);
    for input in inputs.values() {
        assert!(std::sync::Arc::ptr_eq(
            first,
            input.audio.as_ref().ok_or("shared audio absent")?
        ));
    }
    fixture.append_audio("audio-conflict", 9)?;
    let error =
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)
            .err()
            .ok_or("conflict accepted")?;
    assert!(error.to_string().contains("audio differs within frame"));
    let silent = GeneratorFixture::new(b"shader source".to_vec())?;
    assert!(
        GeneratorInput::collect(&silent.records, &silent.root, &silent.registry, &limits)?
            .values()
            .all(|input| input.audio.is_none())
    );
    Ok(())
}

#[test]
fn supplied_generators_require_matching_frame_identity_closure_and_shader_text()
-> Result<(), Box<dyn std::error::Error>> {
    let limits = DecodeLimits::default();
    let fixture = GeneratorFixture::new(b"shader source".to_vec())?;
    let inputs =
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)?;
    assert_eq!(inputs.len(), 1);
    let input = inputs.values().next().ok_or("input missing")?;
    assert_eq!(input.required_bytes(), 1024 * 48 + 208 + 2048 + 16);
    for mode in [
        "time",
        "capacity",
        "unavailable",
        "duplicate",
        "missing",
        "shader",
    ] {
        let mut fixture = GeneratorFixture::new(if mode == "shader" {
            vec![255]
        } else {
            b"shader source".to_vec()
        })?;
        match mode {
            "time" => fixture.root.metadata.header.project_revision -= 1,
            "capacity" => {
                fixture.records[0].execution = PrecompositionGeneratorExecution::Ready {
                    capacity: 2048,
                    effective_count: 256,
                }
            }
            "unavailable" => {
                fixture.records[0].execution = PrecompositionGeneratorExecution::Unavailable
            }
            "duplicate" => fixture.records.push(fixture.records[0].clone()),
            "missing" => fixture.records.clear(),
            _ => {}
        }
        assert!(
            GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)
                .is_err(),
            "{mode}"
        );
    }
    Ok(())
}

#[test]
fn captured_child_generator_scope_and_unavailability_preserve_closure()
-> Result<(), Box<dyn std::error::Error>> {
    let limits = DecodeLimits::default();
    let mut fixture = GeneratorFixture::new(b"shader source".to_vec())?;
    let mut plan = FplnCodec::decode(
        fixture.registry.resolve(&fixture.records[0].plan)?.to_vec(),
        &limits,
    )?;
    let payload = plan.blob(0)?.to_vec();
    fixture.root.metadata.header.snapshot_scope = "precomposition-scenes".into();
    plan.metadata.header.snapshot_scope = "precomposition-generators".into();
    fixture.records[0].plan = GeneratorFixture::register(
        &mut fixture.registry,
        FplnCodec::encode(plan.metadata, &[&payload], &limits)?,
    )?;
    assert_eq!(
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)?.len(),
        1
    );
    fixture.records[0].execution = PrecompositionGeneratorExecution::Unavailable;
    assert!(
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)
            .is_err()
    );
    let Some(PlanSlice::RootSceneCommands(root)) = fixture.root.metadata.slices.first_mut() else {
        return Err("root absent".into());
    };
    root.commands.clear();
    assert!(
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)?
            .is_empty()
    );
    fixture.records[0].execution = PrecompositionGeneratorExecution::Planned;
    assert!(
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)
            .is_err()
    );
    fixture.records[0].execution = PrecompositionGeneratorExecution::Unavailable;
    fixture.records.push(fixture.records[0].clone());
    assert!(
        GeneratorInput::collect(&fixture.records, &fixture.root, &fixture.registry, &limits)
            .is_err()
    );
    Ok(())
}

#[test]
fn root_frame_audio_unifies_independent_scene_records_and_rejects_conflicts()
-> Result<(), Box<dyn std::error::Error>> {
    let limits = DecodeLimits::default();
    let mut parent = GeneratorFixture::new(b"shader source".to_vec())?;
    let mut child = GeneratorFixture::new(b"shader source".to_vec())?;
    child.append_audio("child-audio", 7)?;
    let inputs = GeneratorInput::collect(&child.records, &child.root, &child.registry, &limits)?;
    let silent = GeneratorInput::collect(&parent.records, &parent.root, &parent.registry, &limits)?;
    let audio = GeneratorInput::shared_audio(
        silent
            .values()
            .chain(inputs.values())
            .map(|g| g.audio.clone()),
    )?
    .ok_or("shared audio absent")?;
    assert_eq!(audio.as_ref(), vec![7; 9280]);
    assert!(GeneratorInput::shared_audio(silent.values().map(|g| g.audio.clone()))?.is_none());
    parent.append_audio("parent-audio", 9)?;
    let conflicting =
        GeneratorInput::collect(&parent.records, &parent.root, &parent.registry, &limits)?;
    assert!(
        GeneratorInput::shared_audio(
            inputs
                .values()
                .chain(conflicting.values())
                .map(|g| g.audio.clone())
        )
        .is_err()
    );
    Ok(())
}
