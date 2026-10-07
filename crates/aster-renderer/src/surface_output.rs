use crate::{
    AuxiliaryPrimaryPipelines, AuxiliaryPrimaryTargets, RenderError, SuppliedFrame,
    SurfacePostPipeline,
};

pub(crate) struct SurfaceOutput {
    auxiliary: AuxiliaryPrimaryPipelines,
    effect: SurfacePostPipeline,
}

impl SurfaceOutput {
    pub fn new(device: &wgpu::Device, layout: &wgpu::BindGroupLayout) -> Result<Self, RenderError> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        Ok(Self {
            auxiliary: AuxiliaryPrimaryPipelines::new(device, &catalog, layout)?,
            effect: SurfacePostPipeline::new(device, &catalog, wgpu::TextureFormat::Bgra8Unorm)?,
        })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        textures: (&wgpu::Texture, &wgpu::Texture),
        caches: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
        ),
    ) -> Result<(), RenderError> {
        let surface = frame
            .surface
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("surface output missing".into()))?;
        let targets = if let Some(plan) = &surface.auxiliary {
            let targets = AuxiliaryPrimaryTargets::new(device, plan, plan.required_bytes())?;
            let bindings =
                plan.draws
                    .iter()
                    .map(|draw| match &draw.texture {
                        aster_render_ir::RootTextureReference::None => Ok(None),
                        aster_render_ir::RootTextureReference::Media { hash } => {
                            let image = frame.images.get(hash).ok_or_else(|| {
                                RenderError::Invalid("auxiliary image absent".into())
                            })?;
                            caches.0.binding(image).map(Some)
                        }
                        aster_render_ir::RootTextureReference::Surface { instance_id } => {
                            caches.1.binding(&frame.surfaces, instance_id).map(Some)
                        }
                        _ => Err(RenderError::Unsupported("auxiliary texture".into())),
                    })
                    .collect::<Result<Vec<_>, RenderError>>()?;
            self.auxiliary
                .record(device, encoder, plan, &targets, &bindings)?;
            Some(targets)
        } else {
            None
        };
        if surface.effect.ready {
            let targets = targets
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("surface attachments absent".into()))?;
            self.effect.record(
                device,
                encoder,
                &surface.effect,
                [textures.0, &targets.colors[1], &targets.colors[4]],
                textures.1,
            )?;
        } else {
            let view = textures.1.create_view(&Default::default());
            // Final output clears even when the captured post effect intentionally records no draw.
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Skipped surface output clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(frame.output_clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        }
        Ok(())
    }
}
