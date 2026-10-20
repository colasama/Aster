use crate::{
    AuxiliaryPrimaryPipelines, AuxiliaryPrimaryTargets, RenderError, frame_depth::FrameDepth,
};
use wgpu::util::DeviceExt;

#[derive(Clone)]
pub(crate) struct DepthTargets {
    pub primary: AuxiliaryPrimaryTargets,
    pub colors: Vec<wgpu::Texture>,
    peel_depth: Option<wgpu::Texture>,
    pub size: aster_render_ir::Extent2d,
    pub tier: i8,
    pub bytes: u64,
}

impl DepthTargets {
    pub fn new(device: &wgpu::Device, plan: &FrameDepth) -> Result<Self, RenderError> {
        let auxiliary = plan
            .auxiliary
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("depth geometry missing".into()))?;
        let primary = AuxiliaryPrimaryTargets::new(device, auxiliary, auxiliary.required_bytes())?;
        Ok(Self::allocate(
            device,
            primary,
            auxiliary.size,
            plan.tier,
            plan.required_bytes(),
        ))
    }

    pub fn allocate(
        device: &wgpu::Device,
        primary: AuxiliaryPrimaryTargets,
        size: aster_render_ir::Extent2d,
        tier: i8,
        bytes: u64,
    ) -> Self {
        let create = |format| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Retained transparent depth target"),
                size: wgpu::Extent3d {
                    width: size.width,
                    height: size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        Self {
            primary,
            colors: (0..if tier >= 2 {
                4
            } else if tier >= 1 {
                2
            } else {
                0
            })
                .map(|_| create(wgpu::TextureFormat::Rgba16Float))
                .collect(),
            peel_depth: (tier >= 2).then(|| create(wgpu::TextureFormat::Depth24Plus)),
            size,
            tier,
            bytes,
        }
    }
}

pub(crate) struct DepthAuxiliaryPipelines {
    pub primary: AuxiliaryPrimaryPipelines,
    passes: Vec<[wgpu::RenderPipeline; 2]>,
    peel_layout: wgpu::BindGroupLayout,
    empty: wgpu::BindGroup,
}

impl DepthAuxiliaryPipelines {
    pub fn new(
        device: &wgpu::Device,
        catalog: &aster_shaders::ShaderCatalog,
        images: &wgpu::BindGroupLayout,
    ) -> Result<Self, RenderError> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared transparent auxiliary shader"),
            source: wgpu::ShaderSource::Wgsl(
                catalog.program("auxiliary-surface")?.source.clone().into(),
            ),
        });
        let peel_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Front depth peel source"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let empty_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Empty auxiliary shape layout"),
            entries: &[],
        });
        let empty = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Empty auxiliary shape binding"),
            layout: &empty_layout,
            entries: &[],
        });
        let mut passes = Vec::new();
        for (index, names) in [
            ["front_color_surface_fragment", "front_color_media_fragment"],
            ["transparent_surface_fragment", "transparent_media_fragment"],
            ["peeled_surface_fragment", "peeled_media_fragment"],
        ]
        .into_iter()
        .enumerate()
        {
            let targets = vec![
                Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba16Float,
                    blend: (index == 1).then_some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL
                });
                if index == 2 { 2 } else { 1 }
            ];
            let depth = (index != 1).then_some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: Some(index == 2),
                depth_compare: Some(if index == 0 {
                    wgpu::CompareFunction::Equal
                } else {
                    wgpu::CompareFunction::LessEqual
                }),
                stencil: Default::default(),
                bias: Default::default(),
            });
            let layouts = [false, true].map(|media| {
                let bindings = [
                    Some(if media { images } else { &empty_layout }),
                    Some(&peel_layout),
                ];
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Transparent auxiliary pipeline layout"),
                    bind_group_layouts: &bindings[..if index == 2 { 2 } else { 1 }],
                    immediate_size: 0,
                })
            });
            passes.push([0, 1].map(|media| {
                AuxiliaryPrimaryPipelines::pipeline(
                    device,
                    &module,
                    names[media],
                    Some(&layouts[media]),
                    &targets,
                    depth.clone(),
                )
            }));
        }
        Ok(Self {
            primary: AuxiliaryPrimaryPipelines::new(device, catalog, images)?,
            passes,
            peel_layout,
            empty,
        })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &FrameDepth,
        targets: &DepthTargets,
        bindings: (
            &[Option<&wgpu::BindGroup>],
            &std::collections::BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>,
        ),
    ) -> Result<(), RenderError> {
        let media = bindings.0;
        let auxiliary = plan
            .auxiliary
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("depth geometry missing".into()))?;
        self.primary
            .record(device, encoder, auxiliary, &targets.primary, bindings)?;
        if plan.tier < 1 {
            return Ok(());
        }
        let buffer = |contents| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Depth auxiliary attributes"),
                contents,
                usage: wgpu::BufferUsages::VERTEX,
            })
        };
        let attributes = (!auxiliary.draws.is_empty()).then(|| {
            [
                buffer(&auxiliary.vertices),
                buffer(&auxiliary.ids),
                buffer(&auxiliary.motion),
            ]
        });
        let front_depth = targets.primary.depth.create_view(&Default::default());
        let peel = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Supplied front depth"),
            layout: &self.peel_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&front_depth),
            }],
        });
        for index in 0..if plan.tier >= 2 { 3 } else { 2 } {
            let colors = if index == 2 {
                &targets.colors[2..4]
            } else {
                &targets.colors[index..index + 1]
            };
            let views = colors
                .iter()
                .map(|t| t.create_view(&Default::default()))
                .collect::<Vec<_>>();
            let attachments = views
                .iter()
                .map(|view| {
                    Some(wgpu::RenderPassColorAttachment {
                        view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })
                })
                .collect::<Vec<_>>();
            let depth = if index == 0 {
                Some(front_depth.clone())
            } else if index == 2 {
                targets
                    .peel_depth
                    .as_ref()
                    .map(|t| t.create_view(&Default::default()))
            } else {
                None
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Native transparent depth pass"),
                color_attachments: &attachments,
                depth_stencil_attachment: depth.as_ref().map(|view| {
                    wgpu::RenderPassDepthStencilAttachment {
                        view,
                        depth_ops: Some(wgpu::Operations {
                            load: if index == 0 {
                                wgpu::LoadOp::Load
                            } else {
                                wgpu::LoadOp::Clear(1.0)
                            },
                            store: if index == 0 {
                                wgpu::StoreOp::Store
                            } else {
                                wgpu::StoreOp::Discard
                            },
                        }),
                        stencil_ops: None,
                    }
                }),
                ..Default::default()
            });
            if let Some(attributes) = &attributes {
                for (slot, b) in attributes.iter().enumerate() {
                    pass.set_vertex_buffer(slot as u32, b.slice(..));
                }
                for (i, (draw, binding)) in auxiliary.draws.iter().zip(media).enumerate() {
                    pass.set_pipeline(&self.passes[index][usize::from(binding.is_some())]);
                    pass.set_bind_group(0, binding.map_or(&self.empty, |b| b), &[]);
                    if index == 2 {
                        pass.set_bind_group(1, &peel, &[]);
                    }
                    pass.draw(
                        draw.first_vertex..draw.first_vertex + draw.vertex_count,
                        i as u32..i as u32 + 1,
                    );
                }
            }
        }
        Ok(())
    }
}
