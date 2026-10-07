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
    assert_eq!(input.required_bytes(), 1024 * 48 + 208 + 2048 + 16 + 9280);
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
