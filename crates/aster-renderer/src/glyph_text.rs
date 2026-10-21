use std::{num::NonZeroU64, sync::Arc};

use aster_render_ir::ResourceHash;
use aster_shaders::ShaderCatalog;
use aster_text::GlyphImageFormat;
use wgpu::util::DeviceExt;

use crate::{GlyphTextAtlas, GlyphTextPlan, RenderError};

pub struct GlyphTextPipeline {
    composite: wgpu::RenderPipeline,
    resolve: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

struct GlyphBinding {
    binding: wgpu::BindGroup,
    clip: [u32; 4],
}

/// Retains atlas coordinates and GPU pages for every submitted draw. The caller owns retirement.
pub struct GlyphTextPass {
    pub generation: ResourceHash,
    pub output: wgpu::Texture,
    pub bytes: u64,
    _atlas: Arc<GlyphTextAtlas>,
    accumulation: wgpu::Texture,
    draws: Vec<GlyphBinding>,
    resolve: wgpu::BindGroup,
}

impl GlyphTextPipeline {
    pub fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native glyph composition"),
            source: wgpu::ShaderSource::Wgsl(
                catalog
                    .program("text-glyph-composite")?
                    .source
                    .clone()
                    .into(),
            ),
        });
        let build = |label, vertex, fragment, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(vertex),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(fragment),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        Ok(Self {
            composite: build(
                "Glyph encoded-sRGB source-over",
                "glyph_vertex",
                "glyph_fragment",
                Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            ),
            resolve: build(
                "Glyph straight-alpha resolve",
                "resolve_vertex",
                "resolve_fragment",
                None,
            ),
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        })
    }

    /// Validate every draw and reserve both targets and uniforms before allocating any output.
    pub fn prepare(
        &self,
        device: &wgpu::Device,
        atlas: Arc<GlyphTextAtlas>,
        plan: &GlyphTextPlan,
        budget: u64,
    ) -> Result<GlyphTextPass, RenderError> {
        let limits = device.limits();
        let generation = plan.validate(
            (
                &atlas.identity,
                atlas.generation.placements.len(),
                &atlas.config,
            ),
            (limits.max_texture_dimension_2d, limits.max_buffer_size),
            budget,
        )?;
        let bytes = plan.required_bytes()?;
        let mut uniforms = vec![0; plan.draws.len() * 256];
        for (index, draw) in plan.draws.iter().enumerate() {
            let glyph = &atlas.generation.placements[draw.placement];
            let [a, b, c, d, e, f] = draw.transform;
            let format = glyph
                .page
                .map_or(0.0, |p| match atlas.generation.pages[p].format {
                    GlyphImageFormat::Coverage => 0.0,
                    GlyphImageFormat::PremultipliedSrgbRgba => 1.0,
                });
            let values = [
                draw.baseline[0] + glyph.origin[0] as f32,
                draw.baseline[1] + glyph.origin[1] as f32,
                glyph.rect[2] as f32,
                glyph.rect[3] as f32,
                glyph.rect[0] as f32,
                glyph.rect[1] as f32,
                glyph.rect[2] as f32,
                glyph.rect[3] as f32,
                a,
                c,
                e,
                0.0,
                b,
                d,
                f,
                0.0,
                draw.color[0],
                draw.color[1],
                draw.color[2],
                draw.color[3],
                plan.size.width as f32,
                plan.size.height as f32,
                format,
                glyph
                    .page
                    .map_or(1.0, |p| atlas.generation.pages[p].dimension as f32),
            ];
            for (lane, value) in values.iter().enumerate() {
                uniforms[index * 256 + lane * 4..index * 256 + lane * 4 + 4]
                    .copy_from_slice(&value.to_le_bytes());
            }
        }
        let buffer = (!uniforms.is_empty()).then(|| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Evaluated glyph draws"),
                contents: &uniforms,
                usage: wgpu::BufferUsages::UNIFORM,
            })
        });
        let mut draws = Vec::new();
        for (index, draw) in plan.draws.iter().enumerate() {
            let Some(page) = atlas.generation.placements[draw.placement].page else {
                continue;
            };
            if draw.clip[2] == 0 || draw.clip[3] == 0 {
                continue;
            }
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Native glyph draw"),
                layout: &self.composite.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &atlas.pages[page].create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: buffer.as_ref().ok_or_else(|| {
                                RenderError::Invalid("glyph uniforms absent".into())
                            })?,
                            offset: index as u64 * 256,
                            size: NonZeroU64::new(96),
                        }),
                    },
                ],
            });
            draws.push(GlyphBinding {
                binding,
                clip: draw.clip,
            });
        }
        let target = |label, format, view_formats| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: plan.size.width,
                    height: plan.size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats,
            })
        };
        let accumulation = target(
            "Glyph encoded premultiplied color",
            wgpu::TextureFormat::Rgba8Unorm,
            &[],
        );
        // Write straight encoded bytes through the unorm view; downstream sampling decodes sRGB.
        let output = target(
            "Native glyph straight sRGB output",
            wgpu::TextureFormat::Rgba8UnormSrgb,
            &[wgpu::TextureFormat::Rgba8Unorm],
        );
        let resolve = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Glyph resolve binding"),
            layout: &self.resolve.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &accumulation.create_view(&Default::default()),
                ),
            }],
        });
        Ok(GlyphTextPass {
            generation,
            output,
            bytes,
            _atlas: atlas,
            accumulation,
            draws,
            resolve,
        })
    }

    /// Record into the caller's command stream; no readback or queue submission is required.
    pub fn record(&self, encoder: &mut wgpu::CommandEncoder, prepared: &GlyphTextPass) {
        let accumulation = prepared.accumulation.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native glyph composition"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &accumulation,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.composite);
        for draw in &prepared.draws {
            pass.set_scissor_rect(draw.clip[0], draw.clip[1], draw.clip[2], draw.clip[3]);
            pass.set_bind_group(0, &draw.binding, &[]);
            pass.draw(0..6, 0..1);
        }
        drop(pass);
        let output = prepared.output.create_view(&wgpu::TextureViewDescriptor {
            format: Some(wgpu::TextureFormat::Rgba8Unorm),
            ..Default::default()
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native glyph alpha resolve"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.resolve);
        pass.set_bind_group(0, &prepared.resolve, &[]);
        pass.draw(0..3, 0..1);
    }
}
