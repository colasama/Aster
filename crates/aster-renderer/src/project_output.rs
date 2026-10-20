use super::NativeRenderer;
use crate::{
    AuxiliaryPrimaryTargets, RenderError, SuppliedFrame, depth_auxiliary::DepthTargets,
    motion_output::MotionTargets,
};
use aster_render_ir::Extent2d;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectOutputRequest {
    pub auxiliary: bool,
    pub depth: bool,
    pub depth_of_field: bool,
    pub motion: bool,
    pub surface: bool,
    pub visualizer: bool,
    pub draw_count: u32,
    pub vertex_count: u32,
    pub auxiliary_budget_bytes: u64,
    pub motion_budget_bytes: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectOutputAvailability {
    pub auxiliary_enabled: bool,
    pub depth_available: bool,
    pub tier: i8,
    pub estimated_bytes: u64,
    pub id_buffer_bytes: u64,
    pub motion_buffer_bytes: u64,
    pub byte_budget: u64,
    pub motion_available: bool,
    pub surface_available: bool,
}

#[derive(Clone)]
pub(super) struct ProjectOutputTargets {
    request: ProjectOutputRequest,
    pub(super) size: Extent2d,
    primary: Option<AuxiliaryPrimaryTargets>,
    depth: Option<DepthTargets>,
    motion: Option<MotionTargets>,
    motion_post: Option<crate::output::PreparedPost>,
    availability: ProjectOutputAvailability,
    pub bytes: u64,
}

impl ProjectOutputTargets {
    /// Existing frame admission accounts for upload buffers; add retained allocations only once.
    pub fn additional_bytes(&self, frame: &SuppliedFrame) -> u64 {
        let pixels = u64::from(self.size.width) * u64::from(self.size.height);
        let motion = frame.motion.as_ref().map_or(0, |motion| {
            pixels * 40 + u64::from(motion.tiles.width) * u64::from(motion.tiles.height) * 16
        });
        let depth = frame
            .depth
            .as_ref()
            .filter(|depth| depth.auxiliary.is_some())
            .map_or(0, |depth| {
                pixels
                    * (32
                        + if depth.tier >= 2 {
                            36
                        } else if depth.tier >= 1 {
                            16
                        } else {
                            0
                        })
            });
        let other = u64::from(
            frame
                .surface
                .as_ref()
                .is_some_and(|surface| surface.auxiliary.is_some()),
        ) + u64::from(
            frame
                .visualizer
                .as_ref()
                .is_some_and(|view| view.auxiliary.is_some()),
        );
        self.bytes
            .saturating_sub(motion + depth + other * pixels * 32)
    }

    pub fn validate(&self, frame: &SuppliedFrame) -> Result<(), RenderError> {
        for auxiliary in [
            frame.motion.as_ref().map(|v| &v.auxiliary),
            frame.depth.as_ref().and_then(|v| v.auxiliary.as_ref()),
            frame.surface.as_ref().and_then(|v| v.auxiliary.as_ref()),
            frame.visualizer.as_ref().and_then(|v| v.auxiliary.as_ref()),
        ]
        .into_iter()
        .flatten()
        {
            if self
                .primary
                .as_ref()
                .is_none_or(|targets| !targets.covers(auxiliary))
            {
                return Err(RenderError::Invalid(
                    "final auxiliary inputs exceed prepared allocations".into(),
                ));
            }
        }
        if frame.motion.is_some() && self.motion.is_none()
            || frame.depth.as_ref().is_some_and(|depth| {
                depth.auxiliary.is_some()
                    && self
                        .depth
                        .as_ref()
                        .is_none_or(|targets| targets.tier != depth.tier)
            })
        {
            return Err(RenderError::Invalid(
                "final output route differs from prepared allocations".into(),
            ));
        }
        Ok(())
    }
}

impl NativeRenderer {
    /// Allocate output attachments and attribute capacity before final output planning.
    pub fn prepare_project_output(
        &mut self,
        request: ProjectOutputRequest,
    ) -> Result<ProjectOutputAvailability, RenderError> {
        let preparation = self
            .project_preparation
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("project target preparation is absent".into()))?;
        let size = preparation.render_size;
        if request.draw_count > 65536
            || request.depth_of_field && !request.depth
            || !request.auxiliary && (request.depth || request.motion || request.surface)
        {
            return Err(RenderError::Invalid(
                "invalid project output allocation request".into(),
            ));
        }
        if let Some(cached) = self
            .project_outputs
            .as_ref()
            .filter(|cache| cache.size == size && cache.request == request)
            .cloned()
        {
            self.install_project_outputs(&cached)?;
            return Ok(cached.availability);
        }
        let old_bytes = self.project_outputs.as_ref().map_or(0, |cache| cache.bytes);
        let generator_bytes = self
            .scene
            .generators
            .as_ref()
            .map_or(0, |generators| generators.allocated_bytes());
        let available = preparation
            .generator_budget
            .saturating_add(old_bytes)
            .saturating_sub(generator_bytes);
        let pixels = u64::from(size.width) * u64::from(size.height);
        let supported = self.device.limits().max_color_attachments >= 5
            && self.device.limits().max_color_attachment_bytes_per_sample >= 28;
        let enabled =
            request.auxiliary && supported && pixels * 32 + 48 <= request.auxiliary_budget_bytes;
        let tier = if !enabled || !request.depth_of_field {
            -1
        } else if pixels * 68 + 48 <= request.auxiliary_budget_bytes {
            2
        } else if pixels * 48 + 48 <= request.auxiliary_budget_bytes {
            1
        } else {
            0
        };
        let estimated = if enabled {
            pixels
                * (32
                    + if tier >= 2 {
                        36
                    } else if tier >= 1 {
                        16
                    } else {
                        0
                    })
        } else {
            0
        };
        let id_capacity = (u64::from(request.draw_count) * 8)
            .max(8)
            .next_power_of_two();
        let motion_capacity = (u64::from(request.vertex_count) * 8)
            .max(8)
            .next_power_of_two();
        let drawn =
            enabled && estimated + id_capacity + motion_capacity <= request.auxiliary_budget_bytes;
        let capacities = if drawn {
            [
                u64::from(request.vertex_count) * 160,
                id_capacity,
                motion_capacity,
            ]
        } else {
            [0; 3]
        };
        let primary_bytes = if enabled {
            pixels * 32 + capacities.iter().sum::<u64>()
        } else {
            0
        };
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let constants = catalog
            .program("motion-blur")?
            .pipeline_constants(&Default::default())?;
        let extent = *constants
            .get("tile_extent")
            .ok_or_else(|| RenderError::Invalid("motion tile extent missing".into()))?
            as u32;
        if extent == 0 {
            return Err(RenderError::Invalid("motion tile extent is zero".into()));
        }
        let tiles = Extent2d {
            width: size.width.div_ceil(extent),
            height: size.height.div_ceil(extent),
        };
        let motion_bytes = pixels * 8 + u64::from(tiles.width) * u64::from(tiles.height) * 16;
        let motion_ready = enabled && request.motion && motion_bytes <= request.motion_budget_bytes;
        let bytes = primary_bytes
            + estimated.saturating_sub(pixels * 32)
            + if motion_ready { motion_bytes + 96 } else { 0 };
        if bytes > available {
            return Err(RenderError::Invalid(
                "project output exceeds remaining GPU budget".into(),
            ));
        }
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        self.discard_project_outputs();
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result = (|| -> Result<ProjectOutputTargets, RenderError> {
            let primary = if enabled {
                Some(AuxiliaryPrimaryTargets::allocate(
                    &self.device,
                    size,
                    capacities,
                    primary_bytes,
                )?)
            } else {
                None
            };
            let depth = primary.as_ref().filter(|_| request.depth).map(|primary| {
                DepthTargets::allocate(
                    &self.device,
                    primary.clone(),
                    size,
                    tier,
                    primary_bytes + estimated.saturating_sub(pixels * 32),
                )
            });
            let motion = primary
                .as_ref()
                .filter(|_| motion_ready)
                .map(|primary| MotionTargets::new(&self.device, size, tiles, primary.clone()));
            let targets = ProjectOutputTargets {
                motion_post: motion.as_ref().map(|targets| {
                    self.output
                        .prepare_motion_post(&self.device, &targets.textures[2])
                }),
                request,
                size,
                primary,
                depth,
                motion,
                bytes,
                availability: ProjectOutputAvailability {
                    auxiliary_enabled: enabled,
                    depth_available: enabled,
                    tier,
                    estimated_bytes: estimated,
                    id_buffer_bytes: capacities[1],
                    motion_buffer_bytes: capacities[2],
                    byte_budget: request.auxiliary_budget_bytes,
                    motion_available: motion_ready,
                    surface_available: enabled && request.surface,
                },
            };
            self.install_project_outputs(&targets)?;
            Ok(targets)
        })();
        let error = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ]
        .into_iter()
        .flatten()
        .next();
        let targets = match (result, error) {
            (_, Some(error)) => {
                self.discard_project_outputs();
                self.project_preparation = None;
                return Err(RenderError::Gpu(error.to_string()));
            }
            (Err(error), _) => {
                self.discard_project_outputs();
                self.project_preparation = None;
                return Err(error);
            }
            (Ok(targets), None) => targets,
        };
        let availability = targets.availability.clone();
        if let Some(preparation) = &mut self.project_preparation {
            preparation.generator_budget = preparation.generator_budget + old_bytes - bytes;
        }
        self.project_outputs = Some(targets);
        Ok(availability)
    }

    fn install_project_outputs(
        &mut self,
        targets: &ProjectOutputTargets,
    ) -> Result<(), RenderError> {
        self.output.prepared_motion = targets.motion_post.clone();
        if targets.depth.is_some() && self.depth_output.is_none() {
            self.depth_output = Some(crate::depth_output::DepthOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if let Some(output) = &mut self.depth_output {
            output.targets = targets.depth.clone();
            output.statistics.resident_bytes =
                targets.depth.as_ref().map_or(0, |target| target.bytes);
        }
        if targets.motion.is_some() && self.motion_output.is_none() {
            self.motion_output = Some(crate::motion_output::MotionOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if let Some(output) = &mut self.motion_output {
            output.targets = targets.motion.clone();
            output.statistics.resident_bytes = if targets.motion.is_some() {
                targets.bytes
            } else {
                0
            };
        }
        if targets.request.surface && self.surface_output.is_none() {
            self.surface_output = Some(crate::surface_output::SurfaceOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if let Some(output) = &mut self.surface_output {
            output.prepared = targets.primary.clone();
        }
        if targets.request.visualizer && self.visualizer.is_none() {
            self.visualizer = Some(crate::visualizer::Visualizer::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if let Some(output) = &mut self.visualizer {
            output.prepared = targets.primary.clone();
        }
        Ok(())
    }

    pub(super) fn discard_project_outputs(&mut self) {
        self.output.prepared_motion = None;
        self.project_outputs = None;
        if let Some(output) = &mut self.depth_output {
            output.targets = None;
            output.statistics.resident_bytes = 0;
        }
        if let Some(output) = &mut self.motion_output {
            output.targets = None;
            output.statistics.resident_bytes = 0;
        }
        if let Some(output) = &mut self.surface_output {
            output.prepared = None;
        }
        if let Some(output) = &mut self.visualizer {
            output.prepared = None;
        }
    }
}
