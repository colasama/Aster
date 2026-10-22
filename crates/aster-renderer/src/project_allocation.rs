use super::{FrameTargets, NativeRenderer};
use crate::{
    RenderError, generator_input::GeneratorInput, surface_cache::SurfaceExtent,
    surface_plan::SurfacePlan,
};
use aster_render_ir::{
    CompositionIdentity, Extent2d, OwnedFpln, PrecompositionGeneratorExecution, ResourceRegistry,
};
use std::collections::{BTreeMap, BTreeSet};

/// Limits of the device that will execute the prepared frame.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectDeviceLimits {
    pub maximum_texture_dimension: u32,
    pub storage_byte_limit: u64,
    pub dispatch_workgroup_limit: u32,
    pub gpu_budget_bytes: u64,
}

pub struct ProjectSurfaceTarget {
    pub id: CompositionIdentity,
    pub size: Extent2d,
}

pub(super) struct ProjectPreparation {
    pub generator_budget: u64,
    pub(super) render_size: Extent2d,
    output_size: Extent2d,
    surfaces: BTreeMap<Vec<u16>, Extent2d>,
}

impl ProjectPreparation {
    pub fn validate(&self, frame: &crate::SuppliedFrame) -> Result<(), RenderError> {
        let surfaces = frame
            .surfaces
            .targets
            .iter()
            .map(|s| (s.key.clone(), s.size))
            .collect();
        if frame.scene.header.render_target != self.render_size
            || frame.scene.header.target != self.output_size
            || self.surfaces != surfaces
        {
            return Err(RenderError::Invalid(
                "final targets differ from project allocations".into(),
            ));
        }
        Ok(())
    }
}

impl NativeRenderer {
    /// Allocate requested targets on the rendering device before publishing readiness.
    /// The normal rendering path reuses these exact target and generator handles.
    pub fn begin_project_frame(
        &mut self,
        render_size: Extent2d,
        output_size: Extent2d,
        surfaces: &[ProjectSurfaceTarget],
    ) -> Result<ProjectDeviceLimits, RenderError> {
        if self.output_lease.upgrade().is_some() {
            return Err(RenderError::Invalid(
                "previous output frame is still leased".into(),
            ));
        }
        self.project_preparation = None;
        let limits = self.device.limits();
        let mut identities = BTreeSet::new();
        let targets = surfaces
            .iter()
            .map(|target| SurfaceExtent {
                key: SurfacePlan::key(&target.id),
                size: target.size,
            })
            .collect::<Vec<_>>();
        if targets.len() > 4096
            || targets
                .iter()
                .any(|t| t.key.is_empty() || !identities.insert(t.key.clone()))
            || std::iter::once(render_size)
                .chain(std::iter::once(output_size))
                .chain(targets.iter().map(|t| t.size))
                .any(|size| {
                    size.width == 0
                        || size.height == 0
                        || size.width > limits.max_texture_dimension_2d
                        || size.height > limits.max_texture_dimension_2d
                })
        {
            return Err(RenderError::Invalid(
                "invalid project target allocation request".into(),
            ));
        }
        let root_bytes = u64::from(render_size.width) * u64::from(render_size.height) * 16
            + u64::from(output_size.width) * u64::from(output_size.height) * 4;
        let surface_bytes = targets
            .iter()
            .map(|t| u64::from(t.size.width) * u64::from(t.size.height) * 12)
            .sum::<u64>();
        if self
            .project_outputs
            .as_ref()
            .is_some_and(|output| output.size != render_size)
        {
            self.device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(self.options.timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            self.discard_project_outputs();
        }
        let retained = self.output.luts.statistics.resident_bytes
            + self.layer_cache.statistics.resident_bytes
            + self.temporal.statistics.resident_bytes
            + self.scene.layer_targets.resident_bytes()
            + self.project_outputs.as_ref().map_or_else(
                || {
                    self.motion_output
                        .as_ref()
                        .map_or(0, |output| output.statistics.resident_bytes)
                        + self
                            .depth_output
                            .as_ref()
                            .map_or(0, |output| output.statistics.resident_bytes)
                },
                |output| output.bytes,
            );
        let image_budget = self
            .options
            .gpu_budget_bytes
            .checked_sub(root_bytes + surface_bytes + retained)
            .ok_or_else(|| RenderError::Invalid("project targets exceed GPU budget".into()))?;
        // Image generations are reusable content, not mandatory attachments of the next frame.
        // Reserve growing targets first; final frame admission re-uploads any required victims.
        self.images.retire(
            &self.device,
            &BTreeSet::new(),
            image_budget,
            self.options.timeout,
        )?;
        let retained = retained + self.images.statistics.resident_bytes;
        let generator_budget =
            self.options.gpu_budget_bytes - root_bytes - surface_bytes - retained;
        self.project_preparation = None;
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        if let Some(generators) = &mut self.scene.generators {
            generators.begin_allocation(generator_budget);
        }
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result: Result<(), RenderError> = (|| {
            if self.targets.as_ref().is_some_and(|targets| {
                targets.render_size != render_size || targets.output_size != output_size
            }) {
                self.targets = None;
            }
            self.surfaces.prepare_extents(
                &self.device,
                &self.images.layout,
                &targets,
                self.options.gpu_budget_bytes - root_bytes - retained,
                self.options.timeout,
            )?;
            if self.targets.as_ref().is_none_or(|targets| {
                targets.render_size != render_size || targets.output_size != output_size
            }) {
                self.targets = None;
                self.targets = Some(FrameTargets::new(&self.device, render_size, output_size));
            }
            Ok(())
        })();
        let error = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ]
        .into_iter()
        .flatten()
        .next();
        if let Some(error) = error {
            self.targets = None;
            self.surfaces.invalidate();
            return Err(RenderError::Gpu(error.to_string()));
        }
        result?;
        self.project_preparation = Some(ProjectPreparation {
            generator_budget,
            render_size,
            output_size,
            surfaces: targets.into_iter().map(|t| (t.key, t.size)).collect(),
        });
        Ok(ProjectDeviceLimits {
            maximum_texture_dimension: limits.max_texture_dimension_2d,
            storage_byte_limit: limits.max_storage_buffer_binding_size,
            dispatch_workgroup_limit: limits.max_compute_workgroups_per_dimension,
            gpu_budget_bytes: self.options.gpu_budget_bytes,
        })
    }

    /// Readiness is returned only after the exact invocation's pipelines and buffers exist.
    pub fn prepare_project_generator(
        &mut self,
        plan: &OwnedFpln,
        registry: &ResourceRegistry,
        frame_audio: Option<&[u8]>,
    ) -> Result<PrecompositionGeneratorExecution, RenderError> {
        let preparation = self
            .project_preparation
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("project target preparation is absent".into()))?;
        let input = GeneratorInput::allocation(plan, registry, frame_audio)?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let generators = self.scene.generators.get_or_insert_with(|| {
            crate::generators::GeneratorPipelines::new(
                &self.device,
                self.scene.generator_overwrite.clone(),
            )
        });
        let result = generators.allocate(&self.device, &input, preparation.generator_budget);
        let error = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ]
        .into_iter()
        .flatten()
        .next();
        if let Some(error) = error {
            self.scene.generators = None;
            self.project_preparation = None;
            return Err(RenderError::Gpu(error.to_string()));
        }
        if let Err(error) = result {
            self.scene.generators = None;
            self.project_preparation = None;
            return Err(error);
        }
        Ok(PrecompositionGeneratorExecution::Ready {
            capacity: input.invocation.capacity,
            effective_count: input.invocation.effective_count,
        })
    }
}
