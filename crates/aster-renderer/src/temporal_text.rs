use aster_render_ir::ResourceHash;
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

use crate::{RenderError, TemporalTextPlan};

/// Shared linear-premultiplied accumulation and straight-alpha sRGB resolve pipelines.
pub struct TemporalTextPipeline {
    accumulate: wgpu::RenderPipeline,
    resolve: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

/// Reusable GPU allocations. Every recording clears exposure so repeated execution cannot accumulate history.
pub struct TemporalTextPass {
    pub output_hash: ResourceHash,
    pub output: wgpu::Texture,
    accumulation: wgpu::Texture,
    samples: Vec<wgpu::BindGroup>,
    resolve: wgpu::BindGroup,
}

impl TemporalTextPipeline {
    pub fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared temporal text shader"),
            source: wgpu::ShaderSource::Wgsl(
                catalog
                    .program("text-motion-blur-raster")?
                    .source
                    .clone()
                    .into(),
            ),
        });
        let build = |label, entry, format, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
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
        let additive = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        };
        Ok(Self {
            accumulate: build(
                "Temporal accumulation",
                "accumulate_fragment",
                wgpu::TextureFormat::Rgba16Float,
                Some(wgpu::BlendState {
                    color: additive,
                    alpha: additive,
                }),
            ),
            resolve: build(
                "Temporal resolve",
                "resolve_fragment",
                wgpu::TextureFormat::Rgba8UnormSrgb,
                None,
            ),
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        })
    }

    /// Validate the complete sample set and budget before allocating any retained target.
    pub fn prepare(
        &self,
        device: &wgpu::Device,
        plan: &TemporalTextPlan,
        samples: &[(ResourceHash, wgpu::Texture)],
        budget: u64,
    ) -> Result<TemporalTextPass, RenderError> {
        if plan.required_bytes() > budget
            || plan.size.width > device.limits().max_texture_dimension_2d
            || plan.size.height > device.limits().max_texture_dimension_2d
            || samples.len() != plan.samples.len()
        {
            return Err(RenderError::Invalid(
                "temporal target budget, extent or sample count differs".into(),
            ));
        }
        for ((expected, _), (hash, texture)) in plan.samples.iter().zip(samples) {
            if hash != expected
                || texture.width() != plan.size.width
                || texture.height() != plan.size.height
                || texture.depth_or_array_layers() != 1
                || texture.sample_count() != 1
                || texture.mip_level_count() != 1
                || texture.dimension() != wgpu::TextureDimension::D2
                || texture.format() != wgpu::TextureFormat::Rgba8UnormSrgb
                || !texture
                    .usage()
                    .contains(wgpu::TextureUsages::TEXTURE_BINDING)
            {
                return Err(RenderError::Invalid(
                    "temporal sample identity or texture differs".into(),
                ));
            }
        }
        let texture = |label, format| {
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
                view_formats: &[],
            })
        };
        let accumulation = texture("Temporal linear HDR", wgpu::TextureFormat::Rgba16Float);
        let output = texture(
            "Temporal resolved raster",
            wgpu::TextureFormat::Rgba8UnormSrgb,
        );
        let mut uniforms = vec![0; plan.samples.len() * 256];
        for (index, (_, weight)) in plan.samples.iter().enumerate() {
            uniforms[index * 256..index * 256 + 4].copy_from_slice(&weight.to_le_bytes());
        }
        let weights = (!uniforms.is_empty()).then(|| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Temporal supplied exposure"),
                contents: &uniforms,
                usage: wgpu::BufferUsages::UNIFORM,
            })
        });
        let mut bindings = Vec::new();
        for (index, (_, texture)) in samples.iter().enumerate() {
            let view = texture.create_view(&Default::default());
            let weights = weights
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("temporal weight allocation absent".into()))?;
            bindings.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Temporal supplied sample"),
                layout: &self.accumulate.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: weights,
                            offset: index as u64 * 256,
                            size: wgpu::BufferSize::new(16),
                        }),
                    },
                ],
            }));
        }
        let resolve = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Temporal resolve input"),
            layout: &self.resolve.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &accumulation.create_view(&Default::default()),
                ),
            }],
        });
        Ok(TemporalTextPass {
            output_hash: plan.output.clone(),
            output,
            accumulation,
            samples: bindings,
            resolve,
        })
    }

    pub fn record(&self, encoder: &mut wgpu::CommandEncoder, prepared: &TemporalTextPass) {
        for (target, pipeline, bindings) in [
            (
                &prepared.accumulation,
                &self.accumulate,
                prepared.samples.as_slice(),
            ),
            (
                &prepared.output,
                &self.resolve,
                std::slice::from_ref(&prepared.resolve),
            ),
        ] {
            let view = target.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Native temporal text"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
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
            for binding in bindings {
                pass.set_bind_group(0, binding, &[]);
                pass.draw(0..3, 0..1);
            }
        }
    }
}
