//! Renders every fused post-process effect to a PNG for visual inspection.
//!
//! Consumes `post-process.wgsl`, `blur-downsample.wgsl`, and `effects.json`
//! produced by the `effect-shot-manifest` vitest test, runs each compiled
//! effect program through the real shader on a headless wgpu device, and
//! writes one PNG per effect. A downsample-only blur pyramid is built once
//! from the scene input and bound at `blur_scene`, matching the layer
//! effect renderer's radius-to-LOD mapping.

use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

use clap::Parser;
use flate2::{Compression, write::ZlibEncoder};
use serde::Deserialize;

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
const MAX_OPERATIONS: usize = 64;
const FLOATS_PER_OPERATION: usize = 16;
const BLUR_PYRAMID_MAX_LEVELS: u32 = 8;
const GLOW_OPCODE: f32 = 102.0;

#[derive(Parser)]
struct Options {
    /// Directory containing post-process.wgsl and effects.json.
    #[arg(long, default_value = "artifacts/effect-screenshots/harness")]
    manifest: PathBuf,
    /// Output directory for the rendered PNGs.
    #[arg(long, default_value = "artifacts/effect-screenshots/effects")]
    out: PathBuf,
}

#[derive(Deserialize)]
struct EffectEntry {
    #[serde(rename = "type")]
    effect_type: String,
    name: String,
    ops: Vec<Vec<f32>>,
}

fn main() -> Result<(), String> {
    let options = Options::parse();
    let shader_source = fs::read_to_string(options.manifest.join("post-process.wgsl"))
        .map_err(|error| format!("reading post-process.wgsl failed: {error}"))?;
    let downsample_source = fs::read_to_string(options.manifest.join("blur-downsample.wgsl"))
        .map_err(|error| format!("reading blur-downsample.wgsl failed: {error}"))?;
    let brightpass_source = fs::read_to_string(options.manifest.join("brightpass-downsample.wgsl"))
        .map_err(|error| format!("reading brightpass-downsample.wgsl failed: {error}"))?;
    let effects: Vec<EffectEntry> = serde_json::from_str(
        &fs::read_to_string(options.manifest.join("effects.json"))
            .map_err(|error| format!("reading effects.json failed: {error}"))?,
    )
    .map_err(|error| format!("parsing effects.json failed: {error}"))?;
    fs::create_dir_all(&options.out).map_err(|error| format!("creating output dir: {error}"))?;

    pollster::block_on(render_all(
        &options,
        &shader_source,
        &downsample_source,
        &brightpass_source,
        &effects,
    ))
}

async fn render_all(
    options: &Options,
    shader_source: &str,
    downsample_source: &str,
    brightpass_source: &str,
    effects: &[EffectEntry],
) -> Result<(), String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|error| format!("requesting an adapter failed: {error}"))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .map_err(|error| format!("requesting a device failed: {error}"))?;

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("post process"),
        source: wgpu::ShaderSource::Wgsl(shader_source.into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("post process layout"),
        entries: &[
            texture_entry(0, wgpu::TextureViewDimension::D2),
            sampler_entry(1),
            buffer_entry(2, wgpu::BufferBindingType::Uniform),
            buffer_entry(3, wgpu::BufferBindingType::Storage { read_only: true }),
            texture_entry(4, wgpu::TextureViewDimension::D3),
            sampler_entry(5),
            texture_entry(6, wgpu::TextureViewDimension::D2),
            texture_entry(7, wgpu::TextureViewDimension::D2),
        ],
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("post process pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("post process pipeline layout"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            }),
        ),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let input = create_scene_texture(&device, &queue);
    let lut = create_identity_lut(&device, &queue);
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("linear sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let lut_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("lut sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let mip_count = mip_level_count();
    let input_view = input.create_view(&Default::default());
    let downsample = downsample_pipeline(&device, downsample_source, "blur pyramid downsample");
    let (pyramid_view, blur_max_lod) = create_blur_pyramid(
        &device,
        &queue,
        &downsample,
        &sampler,
        &input_view,
        mip_count,
    );
    let masked = MaskedPyramid::new(
        &device,
        brightpass_source,
        downsample_source,
        &sampler,
        &input_view,
        mip_count,
    );
    let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("post process uniforms"),
        size: 96,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let program = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("effect program"),
        size: (MAX_OPERATIONS * FLOATS_PER_OPERATION * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let output = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("effect output"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("post process resources"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &input.create_view(&Default::default()),
                ),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: uniforms.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: program.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::TextureView(&lut.create_view(
                    &wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D3),
                        ..Default::default()
                    },
                )),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::Sampler(&lut_sampler),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: wgpu::BindingResource::TextureView(&pyramid_view),
            },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: wgpu::BindingResource::TextureView(&masked.view),
            },
        ],
    });

    let padded_row = WIDTH * 4;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(padded_row * HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut index_lines = String::new();
    for (index, entry) in effects.iter().enumerate() {
        if entry.ops.is_empty() {
            println!(
                "skip {} ({}): no compiled ops",
                entry.effect_type, entry.name
            );
            continue;
        }
        let glow_threshold = entry
            .ops
            .iter()
            .filter(|op| op.first() == Some(&GLOW_OPCODE))
            .map(|op| op.get(1).copied().unwrap_or_default())
            .reduce(f32::max);
        let ops = flatten_ops(&entry.ops);
        queue.write_buffer(&program, 0, &ops);
        queue.write_buffer(
            &uniforms,
            0,
            &uniform_data(
                entry.ops.len() as f32,
                blur_max_lod,
                if glow_threshold.is_some() { 1.0 } else { 0.0 },
            ),
        );

        let mut encoder = device.create_command_encoder(&Default::default());
        if let Some(threshold) = glow_threshold {
            masked.encode(&queue, &mut encoder, threshold);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("effect pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output.create_view(&Default::default()),
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(HEIGHT),
                },
            },
            wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
        );
        let submission = queue.submit([encoder.finish()]);
        let pixels = map_readback(&device, &readback, submission)?;

        let filename = format!("{:03}-{}.png", index + 1, entry.effect_type);
        let path = options.out.join(&filename);
        write_png(&path, WIDTH, HEIGHT, &over_checkerboard(&pixels))
            .map_err(|error| format!("writing {filename} failed: {error}"))?;
        index_lines.push_str(&format!(
            "{filename}\t{}\t{}\n",
            entry.name, entry.effect_type
        ));
    }
    fs::write(options.out.join("index.txt"), index_lines)
        .map_err(|error| format!("writing index.txt failed: {error}"))?;
    println!(
        "rendered {} effects into {}",
        effects.len(),
        options.out.display()
    );
    Ok(())
}

fn mip_level_count() -> u32 {
    let base = (WIDTH / 2).max(HEIGHT / 2);
    BLUR_PYRAMID_MAX_LEVELS.min((base as f32).log2().floor() as u32 + 1)
}

fn create_chain_texture(
    device: &wgpu::Device,
    label: &str,
    mip_count: u32,
) -> (wgpu::Texture, Vec<wgpu::TextureView>) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: (WIDTH / 2).max(1),
            height: (HEIGHT / 2).max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: mip_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let views = (0..mip_count)
        .map(|level| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level,
                mip_level_count: Some(1),
                ..Default::default()
            })
        })
        .collect();
    (texture, views)
}

fn downsample_pipeline(device: &wgpu::Device, source: &str, label: &str) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn encode_downsample_pass(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
    target: &wgpu::TextureView,
    label: &str,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

/// Builds the downsample-only blur chain from the scene input once; every
/// effect renders against the same source, so the chain is shared by all
/// `sample_blur` gatherers through the `blur_scene` binding.
fn create_blur_pyramid(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &wgpu::RenderPipeline,
    sampler: &wgpu::Sampler,
    input_view: &wgpu::TextureView,
    mip_count: u32,
) -> (wgpu::TextureView, f32) {
    let (texture, mip_views) = create_chain_texture(device, "blur pyramid", mip_count);
    let layout = pipeline.get_bind_group_layout(0);
    let mut encoder = device.create_command_encoder(&Default::default());
    for level in 0..mip_count as usize {
        let source_view = if level == 0 {
            input_view
        } else {
            &mip_views[level - 1]
        };
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blur pyramid level source"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        });
        encode_downsample_pass(
            &mut encoder,
            pipeline,
            &bind_group,
            &mip_views[level],
            "blur pyramid level",
        );
    }
    queue.submit([encoder.finish()]);
    (
        texture.create_view(&Default::default()),
        (mip_count - 1) as f32,
    )
}

/// Masked blur chain for glow effects: level 0 bright-passes the scene input
/// with a threshold uniform, higher levels reuse the plain Kawase filter, so
/// each mip stores `blur(bright-pass source)` at the same radius mapping the
/// fused shader applies to `sample_blur`.
struct MaskedPyramid {
    view: wgpu::TextureView,
    mip_views: Vec<wgpu::TextureView>,
    seed_pipeline: wgpu::RenderPipeline,
    seed_bind_group: wgpu::BindGroup,
    propagate_pipeline: wgpu::RenderPipeline,
    propagate_bind_groups: Vec<wgpu::BindGroup>,
    threshold: wgpu::Buffer,
}

impl MaskedPyramid {
    fn new(
        device: &wgpu::Device,
        brightpass_source: &str,
        downsample_source: &str,
        sampler: &wgpu::Sampler,
        input_view: &wgpu::TextureView,
        mip_count: u32,
    ) -> Self {
        let seed_pipeline = downsample_pipeline(device, brightpass_source, "brightpass seed");
        let propagate_pipeline =
            downsample_pipeline(device, downsample_source, "brightpass propagate");
        let threshold = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("brightpass threshold"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (texture, mip_views) = create_chain_texture(device, "brightpass pyramid", mip_count);
        let seed_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("brightpass seed source"),
            layout: &seed_pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: threshold.as_entire_binding(),
                },
            ],
        });
        let layout = propagate_pipeline.get_bind_group_layout(0);
        let propagate_bind_groups = mip_views
            .iter()
            .take(mip_views.len().saturating_sub(1))
            .map(|source_view| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("brightpass level source"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(sampler),
                        },
                    ],
                })
            })
            .collect();
        Self {
            view: texture.create_view(&Default::default()),
            mip_views,
            seed_pipeline,
            seed_bind_group,
            propagate_pipeline,
            propagate_bind_groups,
            threshold,
        }
    }

    fn encode(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, threshold: f32) {
        let data: Vec<u8> = [threshold, 0.0, 0.0, 0.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        queue.write_buffer(&self.threshold, 0, &data);
        for (level, target) in self.mip_views.iter().enumerate() {
            let (pipeline, bind_group) = if level == 0 {
                (&self.seed_pipeline, &self.seed_bind_group)
            } else {
                (
                    &self.propagate_pipeline,
                    &self.propagate_bind_groups[level - 1],
                )
            };
            encode_downsample_pass(encoder, pipeline, bind_group, target, "brightpass level");
        }
    }
}

fn texture_entry(
    binding: u32,
    dimension: wgpu::TextureViewDimension,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: dimension,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

fn buffer_entry(binding: u32, ty: wgpu::BufferBindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn flatten_ops(ops: &[Vec<f32>]) -> Vec<u8> {
    let mut bytes = vec![0u8; MAX_OPERATIONS * FLOATS_PER_OPERATION * 4];
    for (index, op) in ops.iter().take(MAX_OPERATIONS).enumerate() {
        for (lane, value) in op.iter().take(FLOATS_PER_OPERATION).enumerate() {
            let offset = (index * FLOATS_PER_OPERATION + lane) * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

/// Mirrors `buildPostProcessUniforms` with the default post-process parameters.
fn uniform_data(operation_count: f32, blur_max_lod: f32, masked_glow: f32) -> Vec<u8> {
    let floats = [
        WIDTH as f32,
        HEIGHT as f32,
        0.5,
        0.0, // resolution, time, exposure
        1.0,
        1.0,
        0.0,
        0.0, // contrast, saturation, temperature, tint
        0.0,
        0.8,
        0.0,
        0.0, // glow, glow threshold, blur, chromatic
        0.0,
        0.0,
        1.0,
        0.0, // vignette, grain, gamma, fade
        operation_count,
        0.0,
        blur_max_lod,
        masked_glow, // program.x, linear output, blur max lod, masked glow chain bound
        0.18,
        0.0,
        1.0,
        0.0, // pivot, lift, gain, padding
    ];
    floats
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7fffff;
    if exponent <= 0 {
        if exponent < -10 {
            return sign;
        }
        return sign | ((mantissa | 0x800000) >> (14 - exponent)) as u16;
    }
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    sign | ((exponent as u16) << 10) | (mantissa >> 13) as u16
}

fn srgb_to_linear(channel: f32) -> f32 {
    if channel <= 0.04045 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

/// Synthetic scene covering saturated colors, smooth gradients, fine detail,
/// flat mid tones, and a dark-to-bright ramp so tonal effects stay readable.
fn create_scene_texture(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test scene"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut data = Vec::with_capacity((WIDTH * HEIGHT * 8) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let (r, g, b) = scene_pixel(x, y);
            for channel in [r, g, b, 1.0] {
                data.extend_from_slice(&f32_to_f16(srgb_to_linear(channel)).to_le_bytes());
            }
        }
    }
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 8),
            rows_per_image: Some(HEIGHT),
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn scene_pixel(x: u32, y: u32) -> (f32, f32, f32) {
    let fx = x as f32 / WIDTH as f32;
    let fy = y as f32 / HEIGHT as f32;
    let mut color = (0.08 + 0.55 * fx, 0.10 + 0.45 * fy, 0.20 + 0.30 * (1.0 - fx));
    // fine vertical stripes for blur, sharpen and resampling effects
    if (20..150).contains(&x) && (20..110).contains(&y) {
        let v = if x % 4 < 2 { 0.92 } else { 0.05 };
        color = (v, v, v);
    }
    // saturated circles for color and edge effects
    for (cx, cy, channel) in [(260.0, 110.0, 0), (400.0, 110.0, 1), (540.0, 110.0, 2)] {
        let dx = x as f32 - cx;
        let dy = y as f32 - cy;
        if dx * dx + dy * dy < 48.0 * 48.0 {
            color = match channel {
                0 => (0.85, 0.12, 0.10),
                1 => (0.15, 0.75, 0.20),
                _ => (0.15, 0.30, 0.90),
            };
        }
    }
    // flat white and black patches for lighting, shadow and matte effects
    if (300..380).contains(&x) && (190..270).contains(&y) {
        color = (0.93, 0.93, 0.93);
    }
    if (420..500).contains(&x) && (190..270).contains(&y) {
        color = (0.02, 0.02, 0.02);
    }
    // luminance ramp along the bottom for tonal effects
    if y >= 312 {
        color = (fx, fx, fx);
    }
    color
}

fn create_identity_lut(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("identity lut"),
        size: wgpu::Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 2,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let identity = [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (1.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
        (1.0, 0.0, 1.0),
        (0.0, 1.0, 1.0),
        (1.0, 1.0, 1.0),
    ];
    let mut data = Vec::with_capacity(identity.len() * 8);
    for (r, g, b) in identity {
        for channel in [r, g, b, 1.0] {
            data.extend_from_slice(&f32_to_f16(channel).to_le_bytes());
        }
    }
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(2 * 8),
            rows_per_image: Some(2),
        },
        wgpu::Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 2,
        },
    );
    texture
}

fn map_readback(
    device: &wgpu::Device,
    buffer: &wgpu::Buffer,
    submission: wgpu::SubmissionIndex,
) -> Result<Vec<u8>, String> {
    let slice = buffer.slice(..);
    let (tx, rx) = mpsc::sync_channel(1);
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    let started = Instant::now();
    device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })
        .map_err(|error| format!("submission did not complete: {error:?}"))?;
    rx.recv_timeout(Duration::from_secs(30).saturating_sub(started.elapsed()))
        .map_err(|error| format!("readback timed out: {error}"))?
        .map_err(|error| format!("readback mapping failed: {error}"))?;
    let mapped = slice
        .get_mapped_range()
        .map_err(|error| format!("map failed: {error}"))?;
    let pixels = mapped.to_vec();
    drop(mapped);
    buffer.unmap();
    Ok(pixels)
}

/// The shader outputs premultiplied sRGB; composite it over a checkerboard so
/// effects that only change alpha remain visible.
fn over_checkerboard(pixels: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity((WIDTH * HEIGHT * 3) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let offset = ((y * WIDTH + x) * 4) as usize;
            let alpha = pixels[offset + 3] as f32 / 255.0;
            let backdrop = if (x / 8 + y / 8) % 2 == 0 { 0.25 } else { 0.38 };
            for channel in 0..3 {
                let source = pixels[offset + channel] as f32 / 255.0;
                rgb.push(((source + backdrop * (1.0 - alpha)) * 255.0) as u8);
            }
        }
    }
    rgb
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xffff_ffff
}

fn png_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut chunk = (payload.len() as u32).to_be_bytes().to_vec();
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(payload);
    chunk.extend_from_slice(&crc32(&chunk[4..]).to_be_bytes());
    chunk
}

fn write_png(path: &PathBuf, width: u32, height: u32, rgb: &[u8]) -> Result<(), String> {
    let mut raw = Vec::with_capacity(((width * 3 + 1) * height) as usize);
    for y in 0..height {
        raw.push(0);
        let row = (y * width * 3) as usize;
        raw.extend_from_slice(&rgb[row..row + (width * 3) as usize]);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(&raw)
        .map_err(|error| format!("deflate failed: {error}"))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("deflate failed: {error}"))?;
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let png = [
        b"\x89PNG\r\n\x1a\n".as_slice(),
        &png_chunk(b"IHDR", &ihdr),
        &png_chunk(b"IDAT", &compressed),
        &png_chunk(b"IEND", &[]),
    ]
    .concat();
    fs::write(path, png).map_err(|error| format!("writing file failed: {error}"))
}
