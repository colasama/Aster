use std::collections::BTreeMap;

use aster_render_ir::{RootCommandRecord, RootLoadOp, RootStoreOp};
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

use crate::{RenderError, SuppliedFrame};

pub(crate) struct ScenePipelines {
    layout: wgpu::BindGroupLayout,
    pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    shadow: wgpu::Texture,
    shadow_sampler: wgpu::Sampler,
    layers: crate::layers::LayerPipelines,
}

impl ScenePipelines {
    pub(crate) fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared scene shape"),
            source: wgpu::ShaderSource::Wgsl(catalog.program("scene-shape")?.source.clone().into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Scene lighting"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Scene pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let attributes = [
            (0, wgpu::VertexFormat::Float32x3),
            (12, wgpu::VertexFormat::Float32x2),
            (20, wgpu::VertexFormat::Float32x4),
            (36, wgpu::VertexFormat::Float32),
            (40, wgpu::VertexFormat::Float32x3),
            (52, wgpu::VertexFormat::Float32x4),
            (68, wgpu::VertexFormat::Float32x3),
            (80, wgpu::VertexFormat::Float32x4),
            (96, wgpu::VertexFormat::Float32x4),
            (112, wgpu::VertexFormat::Float32x4),
            (128, wgpu::VertexFormat::Float32x4),
            (144, wgpu::VertexFormat::Float32x4),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (offset, format))| wgpu::VertexAttribute {
            format,
            offset,
            shader_location: index as u32,
        })
        .collect::<Vec<_>>();
        let mut pipelines = BTreeMap::new();
        for (index, (source, destination)) in [
            (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha),
            (wgpu::BlendFactor::One, wgpu::BlendFactor::One),
            (wgpu::BlendFactor::Dst, wgpu::BlendFactor::Zero),
            (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrc),
        ]
        .into_iter()
        .enumerate()
        {
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Native shape blend"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: 160,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &attributes,
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: Some(wgpu::BlendState {
                            color: wgpu::BlendComponent {
                                src_factor: source,
                                dst_factor: destination,
                                operation: wgpu::BlendOperation::Add,
                            },
                            alpha: wgpu::BlendComponent {
                                src_factor: wgpu::BlendFactor::One,
                                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                                operation: wgpu::BlendOperation::Add,
                            },
                        }),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::LessEqual),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            pipelines.insert(index as u8, pipeline);
        }
        let shadow = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Unoccluded shadow fallback"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth24Plus,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let layers = crate::layers::LayerPipelines::new(device, catalog)?;
        Ok(Self {
            layers,
            layout,
            pipelines,
            shadow,
            shadow_sampler,
        })
    }

    pub(crate) fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        scene: &wgpu::Texture,
        depth: &wgpu::TextureView,
        output: &crate::output::OutputPipelines,
    ) -> Result<(), RenderError> {
        let lighting = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied lighting"),
            contents: &frame.lighting,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied geometry"),
            contents: if frame.vertices.is_empty() {
                &[0; 160]
            } else {
                &frame.vertices
            },
            usage: wgpu::BufferUsages::VERTEX,
        });
        let shadow_view = self.shadow.create_view(&Default::default());
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Supplied scene bindings"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: lighting.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&shadow_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.shadow_sampler),
                },
            ],
        });
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Clear unoccluded shadow"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &shadow_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        }));
        let scene_view = scene.create_view(&Default::default());
        let layer_targets = (!frame.layers.is_empty())
            .then(|| crate::layers::LayerTargets::new(device, frame.header.render_target));
        let layer_views = layer_targets.as_ref().map(|targets| {
            (
                targets.input.create_view(&Default::default()),
                targets.depth.create_view(&Default::default()),
            )
        });
        let mut index = 0;
        while index < frame.root.commands.len() {
            let (
                color_view,
                depth_view,
                clear,
                color_load,
                color_store,
                depth_load,
                depth_store,
                layer_key,
            ) = match &frame.root.commands[index] {
                RootCommandRecord::BeginScene {
                    color_load,
                    color_store,
                    depth_load,
                    depth_store,
                    clear_index,
                    ..
                } => {
                    let clear = *frame
                        .clears
                        .get(*clear_index as usize)
                        .ok_or_else(|| RenderError::Invalid("clear address".into()))?;
                    (
                        &scene_view,
                        depth,
                        clear,
                        *color_load,
                        *color_store,
                        *depth_load,
                        *depth_store,
                        None,
                    )
                }
                RootCommandRecord::BeginLayer { effect_blob_index } => {
                    let views = layer_views
                        .as_ref()
                        .ok_or_else(|| RenderError::Invalid("layer targets absent".into()))?;
                    (
                        &views.0,
                        &views.1,
                        [0.0, 0.0, 0.0, 0.0, 1.0],
                        RootLoadOp::Clear,
                        RootStoreOp::Store,
                        RootLoadOp::Clear,
                        RootStoreOp::Discard,
                        Some(*effect_blob_index),
                    )
                }
                _ => return Err(RenderError::Invalid("expected render pass boundary".into())),
            };
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Native linear HDR scene"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: color_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: if color_load == RootLoadOp::Clear {
                                wgpu::LoadOp::Clear(wgpu::Color {
                                    r: clear[0],
                                    g: clear[1],
                                    b: clear[2],
                                    a: clear[3],
                                })
                            } else {
                                wgpu::LoadOp::Load
                            },
                            store: if color_store == RootStoreOp::Store {
                                wgpu::StoreOp::Store
                            } else {
                                wgpu::StoreOp::Discard
                            },
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: depth_view,
                        depth_ops: Some(wgpu::Operations {
                            load: if depth_load == RootLoadOp::Clear {
                                wgpu::LoadOp::Clear(clear[4] as f32)
                            } else {
                                wgpu::LoadOp::Load
                            },
                            store: if depth_store == RootStoreOp::Store {
                                wgpu::StoreOp::Store
                            } else {
                                wgpu::StoreOp::Discard
                            },
                        }),
                        stencil_ops: None,
                    }),
                    ..Default::default()
                });
                pass.set_bind_group(0, &bindings, &[]);
                pass.set_vertex_buffer(0, vertices.slice(..));
                index += 1;
                while let Some(command) = frame.root.commands.get(index) {
                    match command {
                        RootCommandRecord::EndScene | RootCommandRecord::FinishLayer => {
                            index += 1;
                            break;
                        }
                        RootCommandRecord::Geometry {
                            draw_index,
                            blend_mode,
                        } => {
                            let draw = &frame.root.draws[*draw_index as usize];
                            let key = SuppliedFrame::blend_index(blend_mode)?;
                            let pipeline = self.pipelines.get(&key).ok_or_else(|| {
                                RenderError::Invalid("missing blend pipeline".into())
                            })?;
                            pass.set_pipeline(pipeline);
                            pass.draw(
                                draw.first_vertex..draw.first_vertex + draw.vertex_count,
                                0..1,
                            );
                        }
                        _ => return Err(RenderError::Invalid("unexpected scene command".into())),
                    }
                    index += 1;
                }
            }
            if let Some(key) = layer_key {
                let plan = frame
                    .layers
                    .get(&key)
                    .ok_or_else(|| RenderError::Invalid("layer program absent".into()))?;
                let targets = layer_targets
                    .as_ref()
                    .ok_or_else(|| RenderError::Invalid("layer allocation absent".into()))?;
                self.layers
                    .finish(device, encoder, plan, targets, output, scene)?;
            }
        }
        Ok(())
    }
}
