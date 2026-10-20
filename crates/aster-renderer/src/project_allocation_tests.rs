use super::{NativeOptions, NativeRenderer, ProjectOutputRequest, ProjectSurfaceTarget};
use crate::{generator_input::GeneratorInput, surface_plan::SurfacePlan};
use aster_render_ir::{
    BufferResourceDescriptor, CompositionIdentity, ContractLevel, DecodeLimits, ElementType,
    Extent2d, FplnCodec, IrFixture, OwnedFpln, PlanSlice, PrecompositionGeneratorExecution,
    PutResource, ResourceDescriptor, ResourceHash, ResourceKind, ResourceRegistry,
};
use std::{collections::BTreeMap, time::Duration};

struct AllocationFixture;
impl AllocationFixture {
    fn motion_frame(
        mode: &str,
    ) -> Result<(crate::SuppliedFrame, ResourceRegistry), Box<dyn std::error::Error>> {
        #[derive(serde::Deserialize)]
        struct Manifest {
            frames: Vec<Frame>,
        }
        #[derive(serde::Deserialize)]
        struct Frame {
            mode: String,
            frame: u32,
            resources: Vec<Resource>,
        }
        #[derive(serde::Deserialize)]
        struct Resource {
            message: aster_render_ir::ResourceMessage,
        }
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/parity/native-motion-frame");
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(base.join("manifest.json"))?)?;
        let mut entry = manifest
            .frames
            .into_iter()
            .find(|entry| entry.mode == mode && entry.frame == 0)
            .ok_or("motion fixture absent")?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        entry.resources.sort_by_key(|resource| !matches!(&resource.message,
            aster_render_ir::ResourceMessage::PutResource(message) if message.kind == ResourceKind::MediaSource));
        for resource in entry.resources {
            let aster_render_ir::ResourceMessage::PutResource(message) = resource.message else {
                return Err("unexpected resource eviction".into());
            };
            let bytes = std::fs::read(base.join(format!("resources/{}.bin", message.hash.0)))?;
            registry.put(message, bytes)?;
        }
        let limits = DecodeLimits::default();
        let plan = FplnCodec::decode(
            std::fs::read(base.join(mode).join("0/replay.fpln"))?,
            &limits,
        )?;
        let frame = crate::SuppliedFrame::new(plan, &registry, &limits, &[])?;
        assert!(frame.motion.is_some());
        Ok((frame, registry))
    }

    fn surface_frame(
        id: &str,
    ) -> Result<(crate::SuppliedFrame, ResourceRegistry), Box<dyn std::error::Error>> {
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/parity/native-surface-frame");
        let limits = DecodeLimits::default();
        let plan = FplnCodec::decode(std::fs::read(base.join(id).join("plan.fpln"))?, &limits)?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        for hash in &plan.metadata.resources {
            let bytes = std::fs::read(base.join(format!("resources/{}.bin", hash.0)))?;
            registry.put(
                PutResource {
                    hash: hash.clone(),
                    kind: ResourceKind::Buffer,
                    descriptor: ResourceDescriptor::Buffer(BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: bytes.len() as u32,
                        byte_length: bytes.len() as u32,
                    }),
                },
                bytes,
            )?;
        }
        Ok((
            crate::SuppliedFrame::new(plan, &registry, &limits, &[])?,
            registry,
        ))
    }

    fn generator() -> Result<(OwnedFpln, ResourceRegistry), Box<dyn std::error::Error>> {
        let limits = DecodeLimits::default();
        let (mut metadata, _) = IrFixture::parts()?;
        let PlanSlice::SceneGenerator(mut invocation) = serde_json::from_str(include_str!(
            "../../../tests/parity/native-generator/invocation.json"
        ))?
        else {
            return Err("generator fixture absent".into());
        };
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        let mut hashes = Vec::new();
        for id in ["particle-compute", "particle-render"] {
            let bytes = catalog.program(id)?.source.as_bytes().to_vec();
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
            hashes.push(hash);
        }
        for pass in &mut invocation.program.graph.compute_passes {
            pass.shader = hashes[0].clone();
        }
        for variant in &mut invocation.program.graph.render_variants {
            variant.shader = hashes[1].clone();
            if let Some(auxiliary) = &mut variant.auxiliary {
                auxiliary.shader = hashes[1].clone();
            }
        }
        let mut payload = vec![0; 2272];
        payload[24..28].copy_from_slice(&invocation.effective_count.to_le_bytes());
        payload[2256..2260].copy_from_slice(&6_u32.to_le_bytes());
        metadata.contract_level = ContractLevel::SceneGeneratorSliceV1;
        metadata.resources = hashes;
        metadata.blobs.truncate(1);
        metadata.blobs[0].byte_length = 2272;
        metadata.blobs[0].element_count = 2272;
        metadata.blobs[0].element_type = ElementType::U8;
        metadata.slices = vec![PlanSlice::SceneGenerator(invocation)];
        Ok((
            FplnCodec::decode(FplnCodec::encode(metadata, &[&payload], &limits)?, &limits)?,
            registry,
        ))
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_project_output_allocations_preserve_rendered_pixels()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        dxcompiler: cfg!(target_os = "windows")
            .then(|| root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 536870912,
        layer_cache_bytes: 0,
        effect_regions: true,
        effect_pipeline_entries: 0,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    for id in [
        "selectionIsolation-off-ready",
        "selectionIsolation-ssaa2x-ready",
        "vectorMotionBlur-fxaa-ready",
        "vectorMotionBlur-ssaa4x-ready",
        "motion-full",
        "motion-enters",
        "motion-exits",
    ] {
        let (frame, registry) = match id.strip_prefix("motion-") {
            Some(mode) => AllocationFixture::motion_frame(mode)?,
            None => AllocationFixture::surface_frame(id)?,
        };
        let reference_frame = renderer.render(&frame, &registry)?;
        let reference = renderer.read_rgba(&reference_frame)?;
        drop(reference_frame);
        let surfaces = frame
            .surfaces
            .targets
            .iter()
            .map(|target| ProjectSurfaceTarget {
                id: CompositionIdentity::Unicode(String::from_utf16_lossy(&target.key)),
                size: target.size,
            })
            .collect::<Vec<_>>();
        renderer.begin_project_frame(
            frame.scene.header.render_target,
            frame.scene.header.target,
            &surfaces,
        )?;
        assert!(frame.scene.generators.is_empty());
        let auxiliary = frame
            .surface
            .as_ref()
            .and_then(|surface| surface.auxiliary.as_ref())
            .or_else(|| frame.motion.as_ref().map(|motion| &motion.auxiliary))
            .ok_or("auxiliary fixture absent")?;
        renderer.prepare_project_output(ProjectOutputRequest {
            auxiliary: true,
            depth: false,
            depth_of_field: false,
            motion: frame.motion.is_some(),
            surface: frame.surface.is_some(),
            visualizer: false,
            draw_count: auxiliary.draws.len() as u32,
            vertex_count: (auxiliary.vertices.len() / 160) as u32,
            auxiliary_budget_bytes: 268435456,
            motion_budget_bytes: 134217728,
        })?;
        let prepared = renderer.render(&frame, &registry)?;
        assert_eq!(
            renderer.read_rgba(&prepared)?,
            reference,
            "prepared output differs: {id}"
        );
    }
    Ok(())
}

#[test]
#[ignore = "requires GPU"]
fn native_project_allocations_are_real_reused_and_budgeted()
-> Result<(), Box<dyn std::error::Error>> {
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        dxcompiler: None,
        gpu_budget_bytes: 1_048_576,
        layer_cache_bytes: 0,
        effect_regions: true,
        effect_pipeline_entries: 0,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    let (plan, registry) = AllocationFixture::generator()?;
    assert!(
        renderer
            .prepare_project_generator(&plan, &registry, None)
            .is_err()
    );
    let size = Extent2d {
        width: 32,
        height: 32,
    };
    let surface = ProjectSurfaceTarget {
        id: CompositionIdentity::Unicode("child".into()),
        size,
    };
    let limits = renderer.begin_project_frame(size, size, &[surface])?;
    assert_eq!(limits.gpu_budget_bytes, 1_048_576);
    let target = renderer
        .targets
        .as_ref()
        .ok_or("root targets absent")?
        .output
        .raw()
        .clone();
    assert_eq!(target.width(), size.width);
    assert_eq!(renderer.surfaces.statistics.allocations, 1);
    let frame_audio = vec![0; 9280];
    let ready = renderer.prepare_project_generator(&plan, &registry, Some(&frame_audio))?;
    assert!(matches!(
        ready,
        PrecompositionGeneratorExecution::Ready {
            capacity: 1024,
            effective_count: 256
        }
    ));
    renderer.prepare_project_generator(&plan, &registry, Some(&frame_audio))?;
    let input = GeneratorInput::allocation(&plan, &registry, None)?;
    assert_eq!(
        input.allocation_key()?,
        GeneratorInput::allocation(&plan, &registry, Some(&frame_audio))?.allocation_key()?
    );
    let key = SurfacePlan::key(&input.invocation.instance_id);
    let inputs = BTreeMap::from([(key.clone(), input)]);
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    let pipelines = renderer
        .scene
        .generators
        .as_ref()
        .ok_or("generator allocation absent")?;
    let first = pipelines.compute(&renderer.device, &mut encoder, &inputs)?;
    let second = pipelines.compute(&renderer.device, &mut encoder, &inputs)?;
    assert_eq!(first[&key].indirect, second[&key].indirect);
    assert_eq!(first[&key].compute, second[&key].compute);
    let submission = renderer.queue.submit([encoder.finish()]);
    renderer.device.poll(wgpu::PollType::Wait {
        submission_index: Some(submission),
        timeout: Some(Duration::from_secs(30)),
    })?;
    let (mut final_frame, _) = AllocationFixture::surface_frame("selectionIsolation-off-ready")?;
    final_frame.scene.generators = inputs;
    let pipelines = renderer
        .scene
        .generators
        .as_mut()
        .ok_or("generators absent")?;
    // No reader: a supplied root audio analysis need not appear in the final generator closure.
    pipelines.prepare(&renderer.device, &final_frame, true)?;
    // A child reader can share root-time audio while another scene's invocation omits it.
    final_frame.generator_audio = Some(std::sync::Arc::from(frame_audio));
    pipelines.prepare(&renderer.device, &final_frame, true)?;
    final_frame.generator_audio = Some(std::sync::Arc::from(vec![1; 9280]));
    assert!(
        pipelines
            .prepare(&renderer.device, &final_frame, true)
            .is_err()
    );
    let request = ProjectOutputRequest {
        auxiliary: true,
        depth: true,
        depth_of_field: true,
        motion: true,
        surface: false,
        visualizer: false,
        draw_count: 2,
        vertex_count: 12,
        auxiliary_budget_bytes: 524288,
        motion_budget_bytes: 262144,
    };
    let observation = renderer.prepare_project_output(request)?;
    assert_eq!(observation.tier, 2);
    assert_eq!(observation.id_buffer_bytes, 16);
    assert_eq!(observation.motion_buffer_bytes, 128);
    assert!(observation.motion_available);
    let motion_binding = renderer
        .output
        .prepared_motion
        .as_ref()
        .ok_or("motion post absent")?
        .binding
        .clone();
    let depth = renderer
        .depth_output
        .as_ref()
        .and_then(|output| output.targets.as_ref())
        .ok_or("depth targets absent")?;
    let retained_color = depth.colors[0].clone();
    let motion = renderer
        .motion_output
        .as_ref()
        .and_then(|output| output.targets.as_ref())
        .ok_or("motion targets absent")?;
    assert_eq!(depth.primary.colors[0], motion.auxiliary.colors[0]);
    assert_eq!(
        motion.textures[2].format(),
        wgpu::TextureFormat::Rgba16Float
    );
    renderer.prepare_project_output(request)?;
    assert_eq!(
        renderer
            .output
            .prepared_motion
            .as_ref()
            .ok_or("motion post absent")?
            .binding,
        motion_binding
    );
    assert_eq!(
        renderer
            .depth_output
            .as_ref()
            .and_then(|output| output.targets.as_ref())
            .ok_or("depth targets absent")?
            .colors[0],
        retained_color
    );
    let reduced = renderer.prepare_project_output(ProjectOutputRequest {
        auxiliary_budget_bytes: 32 * 32 * 32 + 48,
        ..request
    })?;
    assert_eq!(reduced.tier, 0);
    assert_eq!(reduced.id_buffer_bytes, 0);
    let unavailable = renderer.prepare_project_output(ProjectOutputRequest {
        auxiliary_budget_bytes: 1,
        ..request
    })?;
    assert!(!unavailable.auxiliary_enabled && !unavailable.motion_available);
    assert!(
        renderer
            .motion_output
            .as_ref()
            .is_none_or(|output| output.targets.is_none())
    );
    let surface = ProjectSurfaceTarget {
        id: CompositionIdentity::Unicode("child".into()),
        size,
    };
    renderer.begin_project_frame(size, size, &[surface])?;
    assert_eq!(
        renderer
            .targets
            .as_ref()
            .ok_or("targets absent")?
            .output
            .raw(),
        &target
    );
    assert_eq!(renderer.surfaces.statistics.allocations, 1);
    assert!(renderer.surfaces.statistics.hits >= 1);
    renderer
        .project_preparation
        .as_mut()
        .ok_or("preparation absent")?
        .generator_budget = 16;
    assert!(
        renderer
            .prepare_project_generator(&plan, &registry, None)
            .is_err()
    );
    assert!(renderer.project_preparation.is_none());
    assert!(renderer.scene.generators.is_none());
    assert!(
        renderer
            .begin_project_frame(
                Extent2d {
                    width: 0,
                    height: 32
                },
                size,
                &[]
            )
            .is_err()
    );
    assert!(renderer.project_preparation.is_none());
    Ok(())
}
