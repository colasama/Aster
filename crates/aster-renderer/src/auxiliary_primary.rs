use aster_render_ir::{
    AuxiliaryDraw, AuxiliaryStatus, ContractLevel, Extent2d, OwnedFpln, PlanSlice,
    RootTextureReference,
};
use wgpu::util::DeviceExt;

use crate::RenderError;

/// Supplied geometry and attributes for the five primary surface attachments.
/// Generator draws reuse beauty instances; transparency and peeling use separate passes.
pub struct AuxiliaryPrimaryPlan {
    pub(crate) size: Extent2d,
    pub(crate) vertices: Vec<u8>,
    pub(crate) ids: Vec<u8>,
    pub(crate) motion: Vec<u8>,
    pub(crate) draws: Vec<AuxiliaryDraw>,
    pub(crate) generators: Vec<aster_render_ir::CompositionIdentity>,
}

impl AuxiliaryPrimaryPlan {
    pub fn new(scene: &OwnedFpln, auxiliary: &OwnedFpln) -> Result<Self, RenderError> {
        if scene.metadata.contract_level != ContractLevel::SceneBuffersSliceV1
            || auxiliary.metadata.contract_level != ContractLevel::AuxiliarySliceV1
            || scene.metadata.header != auxiliary.metadata.header
            || scene.metadata.slices.len() != 1
            || auxiliary.metadata.slices.len() != 1
        {
            return Err(RenderError::Invalid(
                "auxiliary scene identity differs".into(),
            ));
        }
        let (Some(PlanSlice::SceneBuffers(geometry)), Some(PlanSlice::Auxiliary(slice))) = (
            scene.metadata.slices.first(),
            auxiliary.metadata.slices.first(),
        ) else {
            return Err(RenderError::Invalid(
                "auxiliary scene slices missing".into(),
            ));
        };
        if slice.status == AuxiliaryStatus::Unavailable {
            return Err(RenderError::Unsupported(
                "unavailable auxiliary surface".into(),
            ));
        }
        if slice.status == AuxiliaryStatus::Drawn && slice.vertex_count != geometry.vertex_count {
            return Err(RenderError::Invalid(
                "auxiliary vertex generation differs".into(),
            ));
        }
        let bytes = auxiliary.blob(slice.blob_index as usize)?;
        let descriptor = auxiliary
            .metadata
            .blobs
            .get(slice.blob_index as usize)
            .ok_or_else(|| RenderError::Invalid("auxiliary descriptor missing".into()))?;
        slice.validate(descriptor, &auxiliary.metadata.resources)?;
        slice.validate_bytes(bytes)?;
        let id_bytes = slice.draws.len() * 8;
        let vertices = scene.blob(geometry.blob_index as usize)?;
        let end = 592 + slice.vertex_count as usize * 160;
        let vertices = vertices
            .get(592..end)
            .ok_or_else(|| RenderError::Invalid("auxiliary geometry truncated".into()))?;
        Ok(Self {
            size: scene.metadata.header.render_target,
            vertices: vertices.to_vec(),
            ids: bytes[..id_bytes].to_vec(),
            motion: if slice.motion {
                bytes[id_bytes..].to_vec()
            } else {
                vec![0; slice.vertex_count as usize * 8]
            },
            draws: slice.draws.clone(),
            generators: slice.generators.clone(),
        })
    }

    pub fn required_bytes(&self) -> u64 {
        u64::from(self.size.width)
            .saturating_mul(u64::from(self.size.height))
            .saturating_mul(32)
            .saturating_add(self.vertices.len() as u64)
            .saturating_add(self.ids.len() as u64)
            .saturating_add(self.motion.len() as u64)
    }
}

pub struct AuxiliaryPrimaryTargets {
    pub(crate) colors: Vec<wgpu::Texture>,
    pub(crate) depth: wgpu::Texture,
    budget: u64,
}

impl AuxiliaryPrimaryTargets {
    pub fn new(
        device: &wgpu::Device,
        plan: &AuxiliaryPrimaryPlan,
        budget: u64,
    ) -> Result<Self, RenderError> {
        if plan.required_bytes() > budget
            || plan.size.width == 0
            || plan.size.height == 0
            || plan.size.width > device.limits().max_texture_dimension_2d
            || plan.size.height > device.limits().max_texture_dimension_2d
        {
            return Err(RenderError::Invalid(
                "auxiliary extent or budget exceeded".into(),
            ));
        }
        let texture = |format, usage| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Native primary auxiliary surface"),
                size: wgpu::Extent3d {
                    width: plan.size.width,
                    height: plan.size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        Ok(Self {
            budget,
            colors: Self::formats()
                .into_iter()
                .map(|format| {
                    texture(
                        format,
                        wgpu::TextureUsages::RENDER_ATTACHMENT
                            | wgpu::TextureUsages::TEXTURE_BINDING
                            | wgpu::TextureUsages::COPY_SRC,
                    )
                })
                .collect(),
            depth: texture(
                wgpu::TextureFormat::Depth24Plus,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            ),
        })
    }

    pub(crate) fn formats() -> [wgpu::TextureFormat; 5] {
        [
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureFormat::R32Uint,
            wgpu::TextureFormat::R32Uint,
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureFormat::Rg16Float,
        ]
    }
}

impl crate::auxiliary_pipelines::AuxiliaryPrimaryPipelines {
    /// Bindings follow supplied draw order and use the caller's content-addressed image layout.
    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &AuxiliaryPrimaryPlan,
        targets: &AuxiliaryPrimaryTargets,
        bindings: (
            &[Option<&wgpu::BindGroup>],
            &std::collections::BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>,
        ),
    ) -> Result<(), RenderError> {
        let (media, generators) = bindings;
        let generated = plan
            .generators
            .iter()
            .map(|id| {
                generators
                    .get(&crate::surface_plan::SurfacePlan::key(id))
                    .ok_or_else(|| {
                        RenderError::Invalid("auxiliary generator binding absent".into())
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if plan.required_bytes() > targets.budget
            || targets.depth.width() != plan.size.width
            || targets.depth.height() != plan.size.height
            || media.len() != plan.draws.len()
            || plan.draws.iter().zip(media).any(|(draw, binding)| {
                matches!(draw.texture, RootTextureReference::None) == binding.is_some()
            })
        {
            return Err(RenderError::Invalid(
                "auxiliary targets or media bindings differ".into(),
            ));
        }
        let buffer = |contents| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Supplied auxiliary vertex attributes"),
                contents,
                usage: wgpu::BufferUsages::VERTEX,
            })
        };
        let attributes = (!plan.draws.is_empty() && !plan.vertices.is_empty()).then(|| {
            [
                buffer(&plan.vertices),
                buffer(&plan.ids),
                buffer(&plan.motion),
            ]
        });
        let views = targets
            .colors
            .iter()
            .map(|texture| texture.create_view(&Default::default()))
            .collect::<Vec<_>>();
        let colors = views
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
        let depth = targets.depth.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native primary auxiliary MRT"),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        if let Some(attributes) = &attributes {
            for (slot, buffer) in attributes.iter().enumerate() {
                pass.set_vertex_buffer(slot as u32, buffer.slice(..));
            }
            for (index, (draw, binding)) in plan.draws.iter().zip(media).enumerate() {
                pass.set_pipeline(if binding.is_some() {
                    &self.media
                } else {
                    &self.shape
                });
                if let Some(binding) = binding {
                    pass.set_bind_group(0, *binding, &[]);
                }
                pass.draw(
                    draw.first_vertex..draw.first_vertex + draw.vertex_count,
                    index as u32..index as u32 + 1,
                );
            }
        }
        for draw in generated {
            pass.set_pipeline(&draw.pipeline);
            pass.set_bind_group(0, &draw.binding, &[]);
            pass.draw_indirect(&draw.indirect, 0);
        }
        Ok(())
    }
}
