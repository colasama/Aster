use std::collections::BTreeMap;

use aster_render_ir::{RootCommandRecord, RootLoadOp, RootStoreOp};
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

use crate::{RenderError, SuppliedFrame};

pub(crate) struct ScenePipelines {
    layout: wgpu::BindGroupLayout,
    pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    image_pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    surface_pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    shadow: wgpu::Texture,
    shadow_sampler: wgpu::Sampler,
    layers: crate::layers::LayerPipelines,
}

impl ScenePipelines {
    pub(crate) fn new(
        device: &wgpu::Device,
        catalog: &ShaderCatalog,
        image_layout: &wgpu::BindGroupLayout,
    ) -> Result<Self, RenderError> {
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
        let pipelines =
            crate::geometry_pipelines::GeometryPipelines::create(device, &module, &layout);
        let image_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared scene image"),
            source: wgpu::ShaderSource::Wgsl(catalog.program("scene-image")?.source.clone().into()),
        });
        let image_pipelines = crate::geometry_pipelines::GeometryPipelines::create(
            device,
            &image_module,
            image_layout,
        );
        let surface_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared premultiplied surface"),
            source: wgpu::ShaderSource::Wgsl(
                catalog
                    .program("precomposition-surface")?
                    .source
                    .clone()
                    .into(),
            ),
        });
        let surface_pipelines = crate::geometry_pipelines::GeometryPipelines::create(
            device,
            &surface_module,
            image_layout,
        );
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
            image_pipelines,
            surface_pipelines,
            shadow,
            shadow_sampler,
        })
    }

    pub(crate) fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &crate::scene_input::SceneInput,
        target: (&wgpu::Texture, &wgpu::TextureView),
        resources: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
            &crate::surface_plan::SurfacePlan,
            &mut crate::layer_cache::LayerCache,
        ),
        output: &crate::output::OutputPipelines,
    ) -> Result<(), RenderError> {
        let (scene, depth) = target;
        let (images, surfaces, surface_plan, cache) = resources;
        let layer_keys = crate::layer_key::LayerKey::collect(frame, &cache.generations)?;
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
        let layer_targets = (!frame.layers.is_empty()).then(|| {
            crate::layers::LayerTargets::new(
                device,
                frame.header.render_target,
                frame.pyramid_levels(),
            )
        });
        let layer_views = layer_targets.as_ref().map(|targets| {
            (
                targets.input.create_view(&Default::default()),
                targets.depth.create_view(&Default::default()),
            )
        });
        let mut index = 0;
        while index < frame.root.commands.len() {
            let cache_key = layer_keys.get(&index);
            if let Some(key) = cache_key
                && let Some(targets) = &layer_targets
                && cache.restore(&key.hash, encoder, targets.output.raw())
            {
                let RootCommandRecord::BeginLayer { effect_blob_index } =
                    &frame.root.commands[index]
                else {
                    return Err(RenderError::Invalid("cached layer boundary".into()));
                };
                let plan = frame
                    .layers
                    .get(effect_blob_index)
                    .ok_or_else(|| RenderError::Invalid("cached layer program absent".into()))?;
                self.layers
                    .composite(device, encoder, plan, targets, scene)?;
                index = key.end + 1;
                continue;
            }
            if let RootCommandRecord::Adjustment { effect_blob_index } = &frame.root.commands[index]
            {
                let plan = frame
                    .layers
                    .get(effect_blob_index)
                    .ok_or_else(|| RenderError::Invalid("adjustment program absent".into()))?;
                let targets = layer_targets
                    .as_ref()
                    .ok_or_else(|| RenderError::Invalid("adjustment targets absent".into()))?;
                self.layers
                    .finish(device, encoder, plan, targets, output, scene)?;
                index += 1;
                continue;
            }
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
                            let pipelines =
                                if let aster_render_ir::RootTextureReference::Media { hash } =
                                    &draw.texture
                                {
                                    let image = frame.images.get(hash).ok_or_else(|| {
                                        RenderError::Invalid("image input absent".into())
                                    })?;
                                    pass.set_bind_group(0, images.binding(image)?, &[]);
                                    &self.image_pipelines
                                } else if let aster_render_ir::RootTextureReference::Surface {
                                    instance_id,
                                } = &draw.texture
                                {
                                    pass.set_bind_group(
                                        0,
                                        surfaces.binding(surface_plan, instance_id)?,
                                        &[],
                                    );
                                    &self.surface_pipelines
                                } else {
                                    pass.set_bind_group(0, &bindings, &[]);
                                    &self.pipelines
                                };
                            let pipeline = pipelines.get(&key).ok_or_else(|| {
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
                if let Some(key) = cache_key {
                    cache.store(&key.hash, encoder, targets.output.raw());
                }
            }
        }
        Ok(())
    }
}
