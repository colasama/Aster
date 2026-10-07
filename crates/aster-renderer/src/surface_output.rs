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
            &std::collections::BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>,
        ),
    ) -> Result<(), RenderError> {
        let surface = frame
            .surface
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("surface output missing".into()))?;
        let targets = if let Some(plan) = &surface.auxiliary {
            let targets = AuxiliaryPrimaryTargets::new(device, plan, plan.required_bytes())?;
            let bindings = plan.bindings(frame, (caches.0, caches.1))?;
            let bindings = bindings.iter().map(Option::as_ref).collect::<Vec<_>>();
            self.auxiliary
                .record(device, encoder, plan, &targets, (&bindings, caches.2))?;
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
