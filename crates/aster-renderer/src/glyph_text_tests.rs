use std::{
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    time::Duration,
};

use aster_render_ir::{Extent2d, ResourceHash};
use aster_text::{
    FontFaceId, GlyphGenerationConfig, GlyphGenerations, GlyphHinting, GlyphImage,
    GlyphImageFormat, GlyphRasterKey,
};
use serde::Deserialize;

use super::{NativeOptions, NativeRenderer};
use crate::{
    GlyphTextAtlas, GlyphTextDraw, GlyphTextPipeline, GlyphTextPlan, TemporalTextPipeline,
    TemporalTextPlan,
    image_cache::ImageCache,
    image_input::{ImageFormat, ImageInput},
};

#[derive(Deserialize)]
struct InputGlyph {
    width: u32,
    height: u32,
    format: String,
    data: Vec<u8>,
}
#[derive(Deserialize)]
struct InputCase {
    id: String,
    draws: Vec<GlyphTextDraw>,
}
#[derive(Deserialize)]
struct Inputs {
    width: u32,
    height: u32,
    glyphs: Vec<InputGlyph>,
    cases: Vec<InputCase>,
}

struct GlyphFixture {
    renderer: NativeRenderer,
    pipeline: GlyphTextPipeline,
    root: PathBuf,
}

impl GlyphFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let renderer = NativeRenderer::new(NativeOptions {
            effect_regions: true,
            layer_cache_bytes: 0,
            effect_pipeline_entries: 16,
            gpu_timestamps: false,
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
        let pipeline =
            GlyphTextPipeline::new(&renderer.device, &aster_shaders::ShaderCatalog::embedded()?)?;
        Ok(Self {
            renderer,
            pipeline,
            root,
        })
    }

    fn atlas(&self, inputs: &Inputs) -> Result<Arc<GlyphTextAtlas>, Box<dyn std::error::Error>> {
        let images = inputs
            .glyphs
            .iter()
            .enumerate()
            .map(|(index, input)| {
                Ok(Arc::new(GlyphImage {
                    key: GlyphRasterKey {
                        face: FontFaceId {
                            sha256: [0; 32],
                            index: 0,
                        },
                        variations: Vec::new(),
                        glyph_id: index as u32,
                        size_bits: 16.0_f32.to_bits(),
                        phase_bits: [0; 2],
                        hinting: GlyphHinting::None,
                        coverage: aster_text::GlyphCoverage::Linear,
                        stroke_bits: None,
                        foreground: [255; 4],
                        prefer_bitmap: true,
                    },
                    format: match input.format.as_str() {
                        "coverage" => GlyphImageFormat::Coverage,
                        "premultiplied_srgb_rgba" => GlyphImageFormat::PremultipliedSrgbRgba,
                        _ => return Err("unknown fixture format"),
                    },
                    width: input.width,
                    height: input.height,
                    origin: [0; 2],
                    nominal_advance: 16.0,
                    data: input.data.clone(),
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut generations = GlyphGenerations::new(GlyphGenerationConfig {
            glyph_page_dimension: 256,
            max_glyph_generations: 1,
            ..Default::default()
        })?;
        let generation = generations.prepare(&images)?;
        let budget = generation.bytes as u64;
        assert!(
            GlyphTextAtlas::upload(
                &self.renderer.device,
                &self.renderer.queue,
                Arc::clone(&generation),
                Default::default(),
                budget - 1
            )
            .is_err()
        );
        let atlas = GlyphTextAtlas::upload(
            &self.renderer.device,
            &self.renderer.queue,
            Arc::clone(&generation),
            Default::default(),
            budget,
        )?;
        let mut changed = images[0].as_ref().clone();
        changed.data[0] = 255;
        assert!(
            generations.prepare(&[Arc::new(changed)]).is_err(),
            "Live GPU atlas must lease its CPU generation"
        );
        Ok(atlas)
    }

    fn readback(
        &self,
        output: &wgpu::Texture,
        record: impl FnOnce(&mut wgpu::CommandEncoder),
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let device = &self.renderer.device;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let row = output.width() * 4;
        let padded = row.div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Glyph diagnostic readback"),
            size: u64::from(padded) * u64::from(output.height()),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        record(&mut encoder);
        encoder.copy_texture_to_buffer(
            output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(output.height()),
                },
            },
            output.size(),
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
        let pixels = buffer
            .slice(..)
            .get_mapped_range()?
            .chunks_exact(padded as usize)
            .flat_map(|r| r[..row as usize].iter().copied())
            .collect();
        buffer.unmap();
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(error.into());
        }
        Ok(pixels)
    }

    fn publish(id: &str, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(directory) = std::env::var_os("ASTER_GLYPH_GPU_OUTPUT") {
            use std::io::Write;
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory)?;
            let target = directory.join(format!("{id}.rgba"));
            if target.exists() {
                return Err("Glyph output already exists".into());
            }
            let temporary = directory.join(format!("{id}-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                f.write_all(bytes)?;
                f.sync_all()?;
                drop(f);
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

    fn temporal(
        &self,
        plans: &[crate::GlyphTextPass],
        pixels: &[Vec<u8>],
        size: Extent2d,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let device = &self.renderer.device;
        let mut images = ImageCache::new(device);
        let mut inputs = Vec::new();
        let frame = ResourceHash("a".repeat(64));
        for prepared in &plans[..2] {
            images.install_derived(
                device,
                vec![(
                    frame.clone(),
                    prepared.generation.clone(),
                    prepared.output.clone(),
                )],
            )?;
            inputs.push(ImageInput {
                frame: frame.clone(),
                pixels: prepared.generation.clone(),
                width: size.width,
                height: size.height,
                format: ImageFormat::Srgb8,
            });
        }
        assert!(
            images
                .install_derived(
                    device,
                    vec![(
                        frame.clone(),
                        plans[0].generation.clone(),
                        plans[1].output.clone()
                    )]
                )
                .is_err()
        );
        let pipeline =
            TemporalTextPipeline::new(device, &aster_shaders::ShaderCatalog::embedded()?)?;
        let plan = TemporalTextPlan {
            size,
            output: ResourceHash("b".repeat(64)),
            samples: vec![
                (inputs[0].pixels.clone(), 0.25),
                (inputs[1].pixels.clone(), 0.75),
            ],
        };
        let samples = inputs
            .iter()
            .map(|input| Ok((input.pixels.clone(), images.texture(input)?.clone())))
            .collect::<Result<Vec<_>, crate::RenderError>>()?;
        let prepared = pipeline.prepare(device, &plan, &samples, plan.required_bytes())?;
        images.install_derived(
            device,
            vec![(
                plan.output.clone(),
                ResourceHash("c".repeat(64)),
                prepared.output.clone(),
            )],
        )?;
        for input in &inputs {
            assert!(images.texture(input).is_ok());
            assert!(images.binding(input).is_ok());
        }
        let actual = self.readback(&prepared.output, |encoder| {
            for pass in &plans[..2] {
                self.pipeline.record(encoder, pass);
            }
            pipeline.record(encoder, &prepared);
        })?;
        let decode = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        let encode = |v: f64| {
            if v <= 0.0031308 {
                12.92 * v
            } else {
                1.055 * v.powf(1.0 / 2.4) - 0.055
            }
        };
        for ((a, b), actual) in pixels[0]
            .chunks_exact(4)
            .zip(pixels[1].chunks_exact(4))
            .zip(actual.chunks_exact(4))
        {
            let alpha = f64::from(a[3]) / 255.0 * 0.25 + f64::from(b[3]) / 255.0 * 0.75;
            assert!((f64::from(actual[3]) - alpha * 255.0).abs() <= 1.0);
            for channel in 0..3 {
                let linear = decode(a[channel]) * f64::from(a[3]) / 255.0 * 0.25
                    + decode(b[channel]) * f64::from(b[3]) / 255.0 * 0.75;
                let expected = if alpha > 0.0 {
                    encode(linear / alpha) * 255.0
                } else {
                    0.0
                };
                assert!(
                    (f64::from(actual[channel]) - expected).abs() <= 2.0,
                    "Temporal glyph color must decode straight sRGB exactly once"
                );
            }
        }
        images.clear_derived();
        assert!(images.texture(&inputs[0]).is_err());
        Ok(())
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_glyph_gpu_composition_and_lifetimes() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = GlyphFixture::new()?;
    let inputs: Inputs = serde_json::from_slice(&std::fs::read(
        fixture
            .root
            .join("tests/parity/native-glyph-composite/fixture.data"),
    )?)?;
    let atlas = fixture.atlas(&inputs)?;
    let mut passes = Vec::new();
    let mut pixels = Vec::new();
    let size = Extent2d {
        width: inputs.width,
        height: inputs.height,
    };
    for case in inputs.cases {
        let mut plan = GlyphTextPlan {
            size,
            draws: case.draws,
        };
        let budget = plan.required_bytes()?;
        let prepared = fixture.pipeline.prepare(
            &fixture.renderer.device,
            Arc::clone(&atlas),
            &plan,
            budget,
        )?;
        let first =
            fixture.readback(&prepared.output, |e| fixture.pipeline.record(e, &prepared))?;
        assert!(first.chunks_exact(4).any(|p| p[3] > 0));
        assert!(
            fixture
                .pipeline
                .prepare(
                    &fixture.renderer.device,
                    Arc::clone(&atlas),
                    &plan,
                    budget - 1
                )
                .is_err()
        );
        let previous = plan.draws[0].placement;
        plan.draws[0].placement = usize::MAX;
        assert!(
            fixture
                .pipeline
                .prepare(&fixture.renderer.device, Arc::clone(&atlas), &plan, budget)
                .is_err()
        );
        plan.draws[0].placement = previous;
        plan.draws[0].color[0] = f32::NAN;
        assert!(
            fixture
                .pipeline
                .prepare(&fixture.renderer.device, Arc::clone(&atlas), &plan, budget)
                .is_err()
        );
        assert_eq!(
            fixture.readback(&prepared.output, |e| fixture.pipeline.record(e, &prepared))?,
            first,
            "Rejected preparation or repeat recording changed prior pixels"
        );
        GlyphFixture::publish(&case.id, &first)?;
        passes.push(prepared);
        pixels.push(first);
    }
    assert_ne!(passes[0].generation, passes[1].generation);
    drop(atlas);
    fixture.temporal(&passes, &pixels, size)?;
    Ok(())
}
