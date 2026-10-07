use crate::{RenderError, scene_input::SceneInput};

pub(crate) struct ShadowPipeline {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
}

impl ShadowPipeline {
    pub fn new(
        device: &wgpu::Device,
        catalog: &aster_shaders::ShaderCatalog,
    ) -> Result<Self, RenderError> {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Supplied shadow lighting layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Native shadow layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared shadow shader"),
            source: wgpu::ShaderSource::Wgsl(
                catalog.program("scene-shadow")?.source.clone().into(),
            ),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Supplied shadow geometry"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 160,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        shader_location: 6,
                        offset: 68,
                        format: wgpu::VertexFormat::Float32x3,
                    }],
                })],
            },
            fragment: None,
            primitive: wgpu::PrimitiveState {
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: wgpu::DepthBiasState {
                    constant: 2,
                    slope_scale: 1.5,
                    clamp: 0.0,
                },
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Ok(Self { layout, pipeline })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SceneInput,
        buffers: (&wgpu::Buffer, &wgpu::Buffer),
        fallback: &wgpu::Texture,
    ) -> Result<wgpu::TextureView, RenderError> {
        if frame.shadow_size > device.limits().max_texture_dimension_2d {
            return Err(RenderError::Invalid(
                "shadow map exceeds device limit".into(),
            ));
        }
        let texture = if frame.shadow_draws.is_empty() {
            fallback.clone()
        } else {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Supplied scene shadow map"),
                size: wgpu::Extent3d {
                    width: frame.shadow_size,
                    height: frame.shadow_size,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth24Plus,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let view = texture.create_view(&Default::default());
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Supplied shadow lighting"),
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffers.0.as_entire_binding(),
            }],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native scene shadows"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        if !frame.shadow_draws.is_empty() {
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &binding, &[]);
            pass.set_vertex_buffer(0, buffers.1.slice(..));
            for range in &frame.shadow_draws {
                pass.draw(range.clone(), 0..1);
            }
        }
        drop(pass);
        Ok(view)
    }
}
