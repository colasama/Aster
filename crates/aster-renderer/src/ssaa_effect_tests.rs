use std::{io::Write, path::Path, sync::Arc, time::Duration};

use aster_render::{TextureResource, TextureResourceDescriptor};
use aster_render_ir::{AntiAliasing, Extent2d, RootCommandRecord};

use super::{LayerFixture, NativeOptions, NativeRenderer, effect_region_tests::RegionFixture};
use crate::{
    device::{FrameTargets, RenderedFrame},
    effect_region::EffectRegions,
    fixed_composite::FixedComposite,
    layers::LayerTargets,
    pyramid::{Pyramid, PyramidPipelines},
    pyramid_levels::PyramidLevels,
};

struct ResolutionExperiment;

impl ResolutionExperiment {
    fn evaluate(
        renderer: &mut NativeRenderer,
        scale: u32,
        glow: bool,
    ) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
        let (mut frame, registry) = RegionFixture::frame()?;
        let target = frame.scene.header.target;
        let size = Extent2d {
            width: target.width * scale,
            height: target.height * scale,
        };
        frame.scene.header.render_target = size;
        frame.scene.header.aa = if scale == 2 {
            AntiAliasing::Ssaa2x
        } else {
            AntiAliasing::Ssaa4x
        };
        frame.scene.clears[0] = [0.0, 0.0, 0.0, 0.0, 1.0];
        frame.post[..4].copy_from_slice(&(size.width as f32).to_le_bytes());
        frame.post[4..8].copy_from_slice(&(size.height as f32).to_le_bytes());
        let plan = frame.scene.layers.get_mut(&999).ok_or("layer")?;
        plan.uniforms[..8].copy_from_slice(&frame.post[..8]);
        plan.uniforms[64..68].copy_from_slice(&1_f32.to_le_bytes());
        let mut operation = [0.0_f32; 16];
        if glow {
            operation[..8].copy_from_slice(&[132.0, 0.2, 0.5, 1.0, 0.7, 12.0, 0.1, 0.5]);
            operation[5] *= scale as f32;
        } else {
            operation[..2].copy_from_slice(&[101.0, 12.0 * scale as f32]);
        }
        plan.operations = operation.into_iter().flat_map(f32::to_le_bytes).collect();
        plan.pyramids = PyramidLevels::for_program(size, &plan.operations, !glow, false);
        let native = LayerFixture::pixels(renderer, &frame, &registry)?;
        let plan = frame.scene.layers.remove(&999).ok_or("layer")?;
        // Keep the native geometry, source resolution, effect radius and pyramid identical.
        // Only the effect output grid changes before bilinear reconstruction and display SSAA.
        let begin = frame.scene.root.commands[0].clone();
        let draws = frame
            .scene
            .root
            .commands
            .iter()
            .filter(|command| matches!(command, RootCommandRecord::Geometry { .. }))
            .cloned()
            .collect::<Vec<_>>();
        frame.scene.root.commands = vec![begin];
        frame.scene.root.commands.extend(draws);
        frame.scene.root.commands.push(RootCommandRecord::EndScene);
        let device = &renderer.device;
        let source = LayerTargets::new(device, size, Default::default());
        let reference = FrameTargets::new(device, size, target);
        let candidate = FrameTargets::new(device, size, target);
        let low = TextureResource::create(
            device,
            TextureResourceDescriptor::texture_2d(
                "Output-resolution effect experiment",
                target.width,
                target.height,
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            ),
        );
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let fixed = FixedComposite::new(device, &catalog)?;
        let pyramids = PyramidPipelines::new(device, &catalog)?;
        let blur = (!glow).then(|| Pyramid::new(device, size, plan.pyramids.blur));
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        renderer.scene.record(
            device,
            &mut encoder,
            &frame.scene,
            (
                source.input.raw(),
                &source.depth.create_view(&Default::default()),
            ),
            (
                &renderer.images,
                &renderer.surfaces,
                &frame.surfaces,
                &mut renderer.layer_cache,
                &mut EffectRegions {
                    enabled: false,
                    statistics: Default::default(),
                },
                None,
            ),
            &renderer.output,
        )?;
        let input = source.input.create_view(&Default::default());
        if let Some(blur) = &blur {
            pyramids.record(
                device,
                &mut encoder,
                &input,
                blur,
                0..plan.pyramids.blur,
                None,
            );
        }
        let pyramid = blur.as_ref().map_or(&input, |p| &p.view);
        for destination in [reference.scene.raw(), low.raw()] {
            renderer.output.record_layer(
                device,
                &mut encoder,
                &plan,
                (&input, &destination.create_view(&Default::default())),
                (pyramid, &input),
                None,
            )?;
        }
        let reconstructed = candidate.scene.create_view(&Default::default());
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Clear reconstruction destination"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &reconstructed,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        }));
        fixed.record(
            device,
            &mut encoder,
            0,
            &low.create_view(&Default::default()),
            &reconstructed,
        )?;
        for targets in [&reference, &candidate] {
            renderer.output.record(
                device,
                &mut encoder,
                &frame,
                &targets.scene.create_view(&Default::default()),
                &targets.display.create_view(&Default::default()),
                &targets.output.create_view(&Default::default()),
            )?;
        }
        let submission = renderer.queue.submit([encoder.finish()]);
        if let Some(error) = pollster::block_on(validation.pop()) {
            return Err(error.into());
        }
        let mut results = Vec::new();
        for targets in [&reference, &candidate] {
            let rendered = RenderedFrame {
                temporal_cache: Default::default(),
                motion_reconstruction: Default::default(),
                depth_effects: Default::default(),
                texture: targets.output.raw().clone(),
                size: target,
                submission: submission.clone(),
                image_cache: Default::default(),
                lut_cache: Default::default(),
                surface_cache: Default::default(),
                layer_cache: Default::default(),
                effect_regions: Default::default(),
                _lease: Arc::new(()),
            };
            results.push(renderer.read_rgba(&rendered)?);
        }
        let reduced = results.pop().ok_or("candidate")?;
        let reference = results.pop().ok_or("reference")?;
        assert_eq!(
            reference, native,
            "Full-resolution control must match the actual renderer"
        );
        assert_ne!(
            reference, reduced,
            "Resolution experiment must exercise resampling"
        );
        Ok((reference, reduced))
    }

    fn save(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        let temporary = path.with_extension("rgba.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if path.exists() {
            return Err("Diagnostic output already exists".into());
        }
        std::fs::rename(temporary, path)?;
        Ok(())
    }
}

#[test]
#[ignore = "requires GPU"]
fn ssaa_effect_resolution_gpu_evaluation() -> Result<(), Box<dyn std::error::Error>> {
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        dxcompiler: cfg!(target_os = "windows").then(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../node_modules/electron/dist/dxcompiler.dll")
        }),
        gpu_budget_bytes: 128 * 1024 * 1024,
        layer_cache_bytes: 0,
        effect_pipeline_entries: 16,
        gpu_timestamps: false,
        effect_regions: false,
        timeout: Duration::from_secs(30),
    })?;
    let output = std::env::var_os("ASTER_SSAA_EXPERIMENT_OUTPUT").map(std::path::PathBuf::from);
    for scale in [2, 4] {
        for glow in [false, true] {
            let (reference, candidate) =
                ResolutionExperiment::evaluate(&mut renderer, scale, glow)?;
            if let Some(output) = &output {
                std::fs::create_dir_all(output)?;
                let id = format!("{}-ssaa{scale}x", if glow { "glow" } else { "blur" });
                ResolutionExperiment::save(
                    &output.join(format!("{id}.reference.rgba")),
                    &reference,
                )?;
                ResolutionExperiment::save(
                    &output.join(format!("{id}.candidate.rgba")),
                    &candidate,
                )?;
            }
        }
    }
    Ok(())
}
