use crate::{
    AuxiliaryPrimaryPipelines, AuxiliaryPrimaryTargets, RenderError, SuppliedFrame,
    frame_motion::FrameMotion, motion_reconstruction::MotionReconstruction,
};

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct MotionStatistics {
    pub allocations: u64,
    pub reuses: u64,
    pub retirements: u64,
    pub resident_bytes: u64,
    pub passes: u64,
}

struct MotionTargets {
    size: aster_render_ir::Extent2d,
    bytes: u64,
    auxiliary: AuxiliaryPrimaryTargets,
    textures: [wgpu::Texture; 3],
}

pub(crate) struct MotionOutput {
    auxiliary: AuxiliaryPrimaryPipelines,
    reconstruction: MotionReconstruction,
    targets: Option<MotionTargets>,
    pub statistics: MotionStatistics,
}

impl MotionOutput {
    pub fn new(device: &wgpu::Device, layout: &wgpu::BindGroupLayout) -> Result<Self, RenderError> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        Ok(Self {
            auxiliary: AuxiliaryPrimaryPipelines::new(device, &catalog, layout)?,
            reconstruction: MotionReconstruction::new(device, &catalog)?,
            targets: None,
            statistics: Default::default(),
        })
    }

    /// Retire targets before the shared frame budget can be reassigned to other caches.
    pub fn retire(
        &mut self,
        device: &wgpu::Device,
        plan: Option<&FrameMotion>,
        timeout: std::time::Duration,
    ) -> Result<(), RenderError> {
        let reusable = self
            .targets
            .as_ref()
            .zip(plan)
            .is_some_and(|(t, p)| t.size == p.size && t.bytes == p.required_bytes());
        self.statistics.passes = if plan.is_some() { 3 } else { 0 };
        if reusable {
            self.statistics.reuses += 1;
            return Ok(());
        }
        if self.targets.is_some() {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|e| RenderError::Gpu(e.to_string()))?;
            self.targets = None;
            self.statistics.retirements += 1;
            self.statistics.resident_bytes = 0;
        }
        Ok(())
    }

    pub fn allocate(
        &mut self,
        device: &wgpu::Device,
        plan: Option<&FrameMotion>,
    ) -> Result<(), RenderError> {
        if self.targets.is_some() {
            return Ok(());
        }
        if let Some(plan) = plan {
            let textures = [plan.tiles, plan.tiles, plan.size].map(|size| {
                device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Retained HDR motion target"),
                    size: wgpu::Extent3d {
                        width: size.width,
                        height: size.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba16Float,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                })
            });
            self.statistics.allocations += 1;
            self.statistics.resident_bytes =
                u64::from(plan.size.width) * u64::from(plan.size.height) * 40
                    + u64::from(plan.tiles.width) * u64::from(plan.tiles.height) * 16;
            self.targets = Some(MotionTargets {
                size: plan.size,
                bytes: plan.required_bytes(),
                textures,
                auxiliary: AuxiliaryPrimaryTargets::new(
                    device,
                    &plan.auxiliary,
                    plan.auxiliary.required_bytes(),
                )?,
            });
        }
        Ok(())
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        scene: &wgpu::Texture,
        caches: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
            &std::collections::BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>,
        ),
    ) -> Result<wgpu::Texture, RenderError> {
        let plan = frame
            .motion
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("motion frame missing".into()))?;
        let targets = self
            .targets
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("motion targets missing".into()))?;
        let bindings = plan.auxiliary.bindings(frame, (caches.0, caches.1))?;
        let bindings = bindings.iter().map(Option::as_ref).collect::<Vec<_>>();
        self.auxiliary.record(
            device,
            encoder,
            &plan.auxiliary,
            &targets.auxiliary,
            (&bindings, caches.2),
        )?;
        self.reconstruction.record(
            device,
            encoder,
            plan,
            [
                scene,
                &targets.auxiliary.colors[4],
                &targets.auxiliary.colors[1],
            ],
            &targets.textures,
        )?;
        Ok(targets.textures[2].clone())
    }
}
