use std::collections::BTreeMap;

use aster_render_ir::AntiAliasing;
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

use crate::{RenderError, SuppliedFrame};

pub(crate) struct OutputPipelines {
    post: wgpu::RenderPipeline,
    linear_post: wgpu::RenderPipeline,
    effects: Option<wgpu::RenderPipeline>,
    post_layout: wgpu::BindGroupLayout,
    aa: BTreeMap<u8, wgpu::RenderPipeline>,
    sampler: wgpu::Sampler,
    lut: wgpu::Texture,
    operations: wgpu::Buffer,
}

impl OutputPipelines {
    pub(crate) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        catalog: &ShaderCatalog,
    ) -> Result<Self, RenderError> {
        let entries = (0..8)
            .map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: match binding {
                    1 | 5 => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    2 | 3 => wgpu::BindingType::Buffer {
                        ty: if binding == 2 {
                            wgpu::BufferBindingType::Uniform
                        } else {
                            wgpu::BufferBindingType::Storage { read_only: true }
                        },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    _ => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: if binding == 4 {
                            wgpu::TextureViewDimension::D3
                        } else {
                            wgpu::TextureViewDimension::D2
                        },
                        multisampled: false,
                    },
                },
            })
            .collect::<Vec<_>>();
        let post_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Root display bindings"),
            entries: &entries,
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Root display layout"),
            bind_group_layouts: &[Some(&post_layout)],
            immediate_size: 0,
        });
        let post_program = catalog.program("post-process")?;
        let constants = post_program
            .pipeline_constants(&BTreeMap::from([("root_zero_operations".into(), 1.0)]))?;
        let constants = constants
            .iter()
            .map(|(key, value)| (key.as_str(), *value))
            .collect::<Vec<_>>();
        let post = Self::pipeline(
            device,
            &post_program.source,
            Some(&layout),
            "fragment_main",
            &constants,
            wgpu::TextureFormat::Bgra8Unorm,
        );
        let linear_post = Self::pipeline(
            device,
            &post_program.source,
            Some(&layout),
            "fragment_main",
            &constants,
            wgpu::TextureFormat::Rgba16Float,
        );
        let aa_program = catalog.program("output-anti-aliasing")?;
        let mut aa = BTreeMap::new();
        aa.insert(
            1,
            Self::pipeline(
                device,
                &aa_program.source,
                None,
                "fxaa",
                &[],
                wgpu::TextureFormat::Bgra8Unorm,
            ),
        );
        for scale in [2, 4] {
            let constants = aa_program
                .pipeline_constants(&BTreeMap::from([("scale".into(), f64::from(scale))]))?;
            let constants = constants
                .iter()
                .map(|(key, value)| (key.as_str(), *value))
                .collect::<Vec<_>>();
            aa.insert(
                scale,
                Self::pipeline(
                    device,
                    &aa_program.source,
                    None,
                    "supersample",
                    &constants,
                    wgpu::TextureFormat::Bgra8Unorm,
                ),
            );
        }
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let lut = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Identity LUT"),
            size: wgpu::Extent3d {
                width: 2,
                height: 2,
                depth_or_array_layers: 2,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut pixels = Vec::new();
        for b in [0, 255] {
            for g in [0, 255] {
                for r in [0, 255] {
                    pixels.extend([r, g, b, 255]);
                }
            }
        }
        queue.write_texture(
            lut.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(8),
                rows_per_image: Some(2),
            },
            lut.size(),
        );
        let operations = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Empty root operations"),
            contents: &[0; 64],
            usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self {
            post,
            linear_post,
            effects: None,
            post_layout,
            aa,
            sampler,
            lut,
            operations,
        })
    }

    pub(crate) fn prepare_effects(&mut self, device: &wgpu::Device) -> Result<(), RenderError> {
        if self.effects.is_none() {
            let catalog = ShaderCatalog::embedded()?;
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Supplied layer program layout"),
                bind_group_layouts: &[Some(&self.post_layout)],
                immediate_size: 0,
            });
            self.effects = Some(Self::pipeline(
                device,
                &catalog.program("post-process")?.source,
                Some(&layout),
                "fragment_main",
                &[],
                wgpu::TextureFormat::Rgba16Float,
            ));
        }
        Ok(())
    }

    fn pipeline(
        device: &wgpu::Device,
        source: &str,
        layout: Option<&wgpu::PipelineLayout>,
        entry: &str,
        constants: &[(&str, f64)],
        format: wgpu::TextureFormat,
    ) -> wgpu::RenderPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(entry),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants,
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    }

    fn post_bindings(
        &self,
        device: &wgpu::Device,
        bytes: &[u8],
        operations: &wgpu::Buffer,
        scene: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied root post uniforms"),
            contents: bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let lut = self.lut.create_view(&Default::default());
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Root display inputs"),
            layout: &self.post_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(scene),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: operations.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&lut),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(scene),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::TextureView(scene),
                },
            ],
        })
    }

    pub(crate) fn record_layer(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &crate::layer_plan::LayerPlan,
        source: &wgpu::TextureView,
        output: &wgpu::TextureView,
    ) -> Result<(), RenderError> {
        let operations = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied layer operations"),
            contents: if plan.operations.is_empty() {
                &[0; 64]
            } else {
                &plan.operations
            },
            usage: wgpu::BufferUsages::STORAGE,
        });
        let pipeline = if plan.operations.is_empty() {
            &self.linear_post
        } else {
            self.effects
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("effect pipeline absent".into()))?
        };
        let bindings = self.post_bindings(device, &plan.uniforms, &operations, source);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Supplied linear layer pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bindings, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }

    pub(crate) fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        scene: &wgpu::TextureView,
        display: &wgpu::TextureView,
        output: &wgpu::TextureView,
    ) -> Result<(), RenderError> {
        let bindings = self.post_bindings(device, &frame.post, &self.operations, scene);
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Linear HDR to sRGB display"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: display,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(frame.output_clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.post);
            pass.set_bind_group(0, &bindings, &[]);
            pass.draw(0..3, 0..1);
        }
        let mode = match frame.header.aa {
            AntiAliasing::Off => return Ok(()),
            AntiAliasing::Fxaa => 1,
            AntiAliasing::Ssaa2x => 2,
            AntiAliasing::Ssaa4x => 4,
        };
        let pipeline = self
            .aa
            .get(&mode)
            .ok_or_else(|| RenderError::Invalid("missing AA pipeline".into()))?;
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(display),
        }];
        if mode == 1 {
            entries.push(wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&self.sampler),
            });
        }
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("AA inputs"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Display anti-aliasing"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bindings, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}
