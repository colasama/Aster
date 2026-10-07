use std::{path::Path, sync::mpsc, time::Duration};

use aster_render_ir::{FplnCodec, ResourceHash};

use super::{NativeOptions, NativeRenderer};
use crate::{TemporalTextPass, TemporalTextPipeline, TemporalTextPlan};

struct TemporalFixture {
    renderer: NativeRenderer,
    pipeline: TemporalTextPipeline,
}

impl TemporalFixture {
    fn new(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let renderer = NativeRenderer::new(NativeOptions {
            effect_regions: true,
            layer_cache_bytes: 0,
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
            gpu_budget_bytes: 16 * 1024 * 1024,
            timeout: Duration::from_secs(30),
        })?;
        let pipeline = TemporalTextPipeline::new(
            &renderer.device,
            &aster_shaders::ShaderCatalog::embedded()?,
        )?;
        Ok(Self { renderer, pipeline })
    }

    fn samples(
        &self,
        root: &Path,
        mode: &str,
        plan: &TemporalTextPlan,
    ) -> Result<Vec<(ResourceHash, wgpu::Texture)>, Box<dyn std::error::Error>> {
        let mut samples = Vec::new();
        for (index, (hash, _)) in plan.samples.iter().enumerate() {
            let bytes = std::fs::read(root.join(format!(
                "tests/parity/native-temporal-text/{mode}-{index}.rgba"
            )))?;
            assert_eq!(
                bytes.len() as u64,
                u64::from(plan.size.width) * u64::from(plan.size.height) * 4
            );
            let texture = self
                .renderer
                .device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("Frozen temporal sample"),
                    size: wgpu::Extent3d {
                        width: plan.size.width,
                        height: plan.size.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
            self.renderer.queue.write_texture(
                texture.as_image_copy(),
                &bytes,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(plan.size.width * 4),
                    rows_per_image: Some(plan.size.height),
                },
                texture.size(),
            );
            samples.push((hash.clone(), texture));
        }
        Ok(samples)
    }

    fn render(&self, prepared: &TemporalTextPass) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let device = &self.renderer.device;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let row = prepared.output.width() * 4;
        let padded = row.div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Temporal diagnostic readback"),
            size: u64::from(padded) * u64::from(prepared.output.height()),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        self.pipeline.record(&mut encoder, prepared);
        encoder.copy_texture_to_buffer(
            prepared.output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(prepared.output.height()),
                },
            },
            prepared.output.size(),
        );
        let submission = self.renderer.queue.submit([encoder.finish()]);
        let (send, receive) = mpsc::sync_channel(1);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = send.send(result);
            });
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;
        receive.recv_timeout(Duration::from_secs(30))??;
        let bytes = buffer
            .slice(..)
            .get_mapped_range()?
            .chunks_exact(padded as usize)
            .flat_map(|line| line[..row as usize].iter().copied())
            .collect();
        buffer.unmap();
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(error.into());
        }
        Ok(bytes)
    }

    fn publish(mode: &str, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(directory) = std::env::var_os("ASTER_TEMPORAL_NATIVE_OUTPUT") {
            use std::io::Write;
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory)?;
            let target = directory.join(format!("{mode}.rgba"));
            if target.exists() {
                return Err("temporal diagnostic output already exists".into());
            }
            let temporary = directory.join(format!("{mode}-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&temporary, target)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(temporary);
            }
            result?;
        }
        Ok(())
    }
}

#[test]
fn temporal_text_supplied_weights_retain_partial_exposure() -> Result<(), Box<dyn std::error::Error>>
{
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (mode, count, total) in [
        ("full", 8, 1.0_f32),
        ("enters", 4, 0.5),
        ("exits", 4, 0.5),
        ("transparent", 0, 0.0),
    ] {
        let mut decoded = FplnCodec::decode(
            std::fs::read(root.join(format!("tests/parity/native-temporal-text/{mode}.fpln")))?,
            &Default::default(),
        )?;
        let plan = TemporalTextPlan::new(&decoded)?;
        assert_eq!(plan.samples.len(), count);
        assert!((plan.samples.iter().map(|(_, weight)| weight).sum::<f32>() - total).abs() < 1e-6);
        assert_eq!(
            plan.required_bytes(),
            u64::from(plan.size.width) * u64::from(plan.size.height) * 12 + count as u64 * 256
        );
        decoded.metadata.contract_level = aster_render_ir::ContractLevel::PostUniformsSliceV1;
        assert!(TemporalTextPlan::new(&decoded).is_err());
    }
    Ok(())
}

#[test]
#[ignore = "requires GPU"]
fn temporal_text_supplied_gpu_outputs_and_controls() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture = TemporalFixture::new(&root)?;
    for mode in ["full", "enters", "exits", "transparent"] {
        let decoded = FplnCodec::decode(
            std::fs::read(root.join(format!("tests/parity/native-temporal-text/{mode}.fpln")))?,
            &Default::default(),
        )?;
        let mut plan = TemporalTextPlan::new(&decoded)?;
        let mut samples = fixture.samples(&root, mode, &plan)?;
        let device = &fixture.renderer.device;
        let prepared = fixture
            .pipeline
            .prepare(device, &plan, &samples, plan.required_bytes())?;
        assert_eq!(prepared.output_hash, plan.output);
        let pixels = fixture.render(&prepared)?;
        assert_eq!(
            fixture.render(&prepared)?,
            pixels,
            "Retained targets must clear previous exposure"
        );
        assert!(
            fixture
                .pipeline
                .prepare(device, &plan, &samples, plan.required_bytes() - 1)
                .is_err()
        );
        assert_eq!(
            fixture.render(&prepared)?,
            pixels,
            "Rejected preparation must preserve existing targets"
        );
        if let Some((hash, _)) = samples.first_mut() {
            let old = hash.clone();
            *hash = plan.output.clone();
            assert!(
                fixture
                    .pipeline
                    .prepare(device, &plan, &samples, plan.required_bytes())
                    .is_err()
            );
            samples[0].0 = old;
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
        } else {
            assert!(pixels.iter().all(|byte| *byte == 0));
        }
        TemporalFixture::publish(mode, &pixels)?;
        for (_, weight) in &mut plan.samples {
            *weight = 0.0;
        }
        let zero = fixture
            .pipeline
            .prepare(device, &plan, &samples, plan.required_bytes())?;
        assert!(
            fixture.render(&zero)?.iter().all(|byte| *byte == 0),
            "Supplied exposure must affect GPU pixels"
        );
    }
    Ok(())
}
