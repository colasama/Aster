use std::{path::PathBuf, sync::mpsc, time::Duration};

use aster_render_ir::{DecodeLimits, FplnCodec, PlanSlice, PostEffectStatus};

use super::{NativeOptions, NativeRenderer};
use crate::{SurfacePostPipeline, SurfacePostPlan};

struct SurfaceFixture {
    renderer: NativeRenderer,
    pipeline: SurfacePostPipeline,
    inputs: Vec<wgpu::Texture>,
    output: wgpu::Texture,
}

impl SurfaceFixture {
    fn new(root: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        let renderer = NativeRenderer::new(NativeOptions {
            dxcompiler: cfg!(target_os = "windows")
                .then(|| root.join("node_modules/electron/dist/dxcompiler.dll")),
            backend: if cfg!(target_os = "windows") {
                aster_render::NativeBackend::Dx12
            } else if cfg!(target_os = "macos") {
                aster_render::NativeBackend::Metal
            } else {
                aster_render::NativeBackend::Vulkan
            },
            adapter_name: None,
            gpu_budget_bytes: 4 * 1024 * 1024,
            timeout: Duration::from_secs(30),
        })?;
        let pipeline = SurfacePostPipeline::new(
            &renderer.device,
            &aster_shaders::ShaderCatalog::embedded()?,
            wgpu::TextureFormat::Rgba8Unorm,
        )?;
        let mut inputs = Vec::new();
        for (name, format, bpp) in [
            ("scene", wgpu::TextureFormat::Rgba16Float, 8),
            ("objectId", wgpu::TextureFormat::R32Uint, 4),
            ("motionVector", wgpu::TextureFormat::Rg16Float, 4),
        ] {
            let texture = renderer.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(name),
                size: wgpu::Extent3d {
                    width: 64,
                    height: 48,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let bytes =
                std::fs::read(root.join(format!("tests/parity/native-surface-post/{name}.bin")))?;
            assert_eq!(bytes.len(), 64 * 48 * bpp);
            renderer.queue.write_texture(
                texture.as_image_copy(),
                &bytes,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(64 * bpp as u32),
                    rows_per_image: Some(48),
                },
                texture.size(),
            );
            inputs.push(texture);
        }
        let output = renderer.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Surface post fixture output"),
            size: wgpu::Extent3d {
                width: 64,
                height: 48,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        Ok(Self {
            renderer,
            pipeline,
            inputs,
            output,
        })
    }

    fn render(
        &self,
        plan: &SurfacePostPlan,
        recorded: bool,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let device = &self.renderer.device;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        assert_eq!(
            self.pipeline.record(
                device,
                &mut encoder,
                plan,
                [&self.inputs[0], &self.inputs[1], &self.inputs[2]],
                &self.output
            )?,
            recorded
        );
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Surface diagnostic readback"),
            size: 64 * 48 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            self.output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(48),
                },
            },
            self.output.size(),
        );
        let submission = self.renderer.queue.submit([encoder.finish()]);
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(error.to_string().into());
        }
        let (sender, receiver) = mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;
        receiver.recv_timeout(Duration::from_secs(30))??;
        let bytes = readback.slice(..).get_mapped_range()?.to_vec();
        readback.unmap();
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires GPU"]
fn surface_post_supplied_gpu_outputs_and_controls() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture = SurfaceFixture::new(&root)?;
    let output = std::env::var_os("ASTER_SURFACE_POST_OUTPUT").map(PathBuf::from);
    if let Some(path) = &output {
        std::fs::create_dir_all(path)?;
    }
    for id in ["selectionIsolation", "vectorMotionBlur"] {
        let bytes =
            std::fs::read(root.join(format!("tests/parity/native-surface-post/{id}.fpln")))?;
        let decoded = FplnCodec::decode(bytes.clone(), &DecodeLimits::default())?;
        let supplied = SurfacePostPlan::new(&decoded)?;
        let actual = fixture.render(&supplied, true)?;
        let reference =
            std::fs::read(root.join(format!("tests/parity/output-replay/reference/{id}.bin")))?;
        assert_eq!(actual.len(), reference.len());
        assert!(
            actual
                .iter()
                .zip(&reference)
                .all(|(a, b)| a.abs_diff(*b) <= 2)
        );
        if let Some(path) = &output {
            use std::io::Write;
            // Exclusive publication keeps repeated or interrupted diagnostics from overwriting evidence.
            let temporary = path.join(format!("{id}.rgba.tmp"));
            let destination = path.join(format!("{id}.rgba"));
            if destination.exists() {
                return Err("surface output already exists".into());
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&actual)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(temporary, destination)?;
        }
        let mut skipped = FplnCodec::decode(bytes.clone(), &DecodeLimits::default())?;
        let Some(PlanSlice::PostEffect(effect)) = skipped.metadata.slices.first_mut() else {
            return Err("effect absent".into());
        };
        effect.status = PostEffectStatus::Skipped;
        assert_eq!(
            fixture.render(&SurfacePostPlan::new(&skipped)?, false)?,
            actual
        );
        let mut encoder = fixture
            .renderer
            .device
            .create_command_encoder(&Default::default());
        assert!(
            fixture
                .pipeline
                .record(
                    &fixture.renderer.device,
                    &mut encoder,
                    &supplied,
                    [&fixture.inputs[0], &fixture.inputs[0], &fixture.inputs[2]],
                    &fixture.output
                )
                .is_err()
        );
        fixture.renderer.queue.submit([encoder.finish()]);
        assert_eq!(
            fixture.render(&SurfacePostPlan::new(&skipped)?, false)?,
            actual
        );
        let mut changed = bytes;
        let start =
            u32::from_le_bytes([changed[16], changed[17], changed[18], changed[19]]) as usize;
        let lane = if id == "selectionIsolation" { 12 } else { 16 };
        changed[start + lane..start + lane + 4].copy_from_slice(&if lane == 12 {
            29_u32.to_le_bytes()
        } else {
            0.0_f32.to_le_bytes()
        });
        let mutated = SurfacePostPlan::new(&FplnCodec::decode(changed, &DecodeLimits::default())?)?;
        let changed_pixels = fixture.render(&mutated, true)?;
        assert!(
            changed_pixels
                .chunks_exact(4)
                .zip(actual.chunks_exact(4))
                .filter(|(a, b)| a != b)
                .count()
                > 16
        );
        assert_eq!(fixture.render(&supplied, true)?, actual);
    }
    Ok(())
}
