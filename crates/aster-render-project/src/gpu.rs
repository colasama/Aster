use crate::ProjectRenderError;
use aster_eval::{
    AuxiliaryBudget, BufferVisualization, BundleGenerator, DepthAttachments, EvaluationError,
    FrameOutputContext, GeneratorDeviceLimits, ProjectFrameAllocator, ProjectResourceRequests,
    ResourcePreparationOperation, SceneFramePlans,
};
use aster_render_ir::{
    CompositionIdentity, DecodeLimits, Extent2d, FrameHeaderSlice, PlanSlice,
    PrecompositionGeneratorExecution, ResourceRegistry,
};
use aster_renderer::{NativeRenderer, ProjectOutputRequest, ProjectSurfaceTarget};

/// Owns the rendering device across native project preparation and frame execution.
pub struct NativeProjectGpu {
    pub renderer: NativeRenderer,
    frame_audio: Option<Vec<u8>>,
    frame: Option<FrameHeaderSlice>,
    memory_budget_bytes: u64,
}

impl NativeProjectGpu {
    /// Resolve auxiliary visualization fallback before native exposure and scene traversal.
    pub fn configure_visualization(
        &mut self,
        mode: BufferVisualization,
    ) -> Result<BufferVisualization, ProjectRenderError> {
        if matches!(
            mode,
            BufferVisualization::Beauty
                | BufferVisualization::LinearColor
                | BufferVisualization::Luminance
                | BufferVisualization::Alpha
        ) {
            return Ok(mode);
        }
        let depth = matches!(
            mode,
            BufferVisualization::DepthFog | BufferVisualization::DepthOfField
        );
        let surface = matches!(
            mode,
            BufferVisualization::SelectionIsolation | BufferVisualization::VectorMotionBlur
        );
        let availability = self.renderer.prepare_project_output(ProjectOutputRequest {
            auxiliary: true,
            depth,
            // Diagnostic views use primary surfaces; layered depth belongs to camera beauty output.
            depth_of_field: false,
            motion: false,
            surface,
            visualizer: !depth && !surface,
            draw_count: 0,
            vertex_count: 0,
            auxiliary_budget_bytes: self.memory_budget_bytes / 2,
            motion_budget_bytes: self.memory_budget_bytes / 4,
        })?;
        Ok(if availability.auxiliary_enabled {
            mode
        } else {
            BufferVisualization::Beauty
        })
    }

    pub fn new(renderer: NativeRenderer) -> Self {
        Self {
            renderer,
            frame_audio: None,
            frame: None,
            memory_budget_bytes: 0,
        }
    }

    pub fn begin(
        &mut self,
        requests: &ProjectResourceRequests,
        audio: Option<&[u32]>,
        memory_budget_mb: Option<f64>,
    ) -> Result<GeneratorDeviceLimits, ProjectRenderError> {
        self.frame = None;
        let memory_mb = memory_budget_mb.unwrap_or(512.);
        if !memory_mb.is_finite()
            || !(1.0..=32768.).contains(&memory_mb)
            || audio.is_some_and(|words| words.len() != 2320)
        {
            return Err(ProjectRenderError::Invalid(
                "invalid GPU preferences or audio ABI".into(),
            ));
        }
        let targets = requests
            .operations
            .iter()
            .filter_map(|operation| match operation {
                ResourcePreparationOperation::Target { target } => Some(ProjectSurfaceTarget {
                    id: CompositionIdentity::Unicode(target.id.clone()),
                    size: Extent2d {
                        width: target.width,
                        height: target.height,
                    },
                }),
                _ => None,
            })
            .collect::<Vec<_>>();
        let limits = self.renderer.begin_project_frame(
            requests.header.render_target,
            requests.header.target,
            &targets,
        )?;
        self.frame_audio =
            audio.map(|words| words.iter().flat_map(|word| word.to_le_bytes()).collect());
        self.frame = Some(requests.header.clone());
        self.memory_budget_bytes = (memory_mb * 1024. * 1024.) as u64;
        Ok(GeneratorDeviceLimits {
            memory_budget_mb: memory_mb,
            storage_byte_limit: limits.storage_byte_limit,
            dispatch_workgroup_limit: limits.dispatch_workgroup_limit,
        })
    }
}

impl ProjectFrameAllocator for &mut NativeProjectGpu {
    fn generator(
        &mut self,
        generator: &BundleGenerator,
    ) -> Result<PrecompositionGeneratorExecution, EvaluationError> {
        if self.frame.is_none() {
            return Err(EvaluationError::InvalidScene(
                "native GPU frame is not prepared".into(),
            ));
        }
        let mut registry = ResourceRegistry::new(Default::default())
            .map_err(|error| EvaluationError::InvalidScene(error.to_string()))?;
        for shader in &generator.shaders {
            registry
                .put_verified(shader.clone())
                .map_err(|error| EvaluationError::InvalidScene(error.to_string()))?;
        }
        let limits = DecodeLimits::default();
        let plan = generator.plan.encode_owned(&limits)?;
        self.renderer
            .prepare_project_generator(&plan, &registry, self.frame_audio.as_deref())
            .map_err(|error| {
                self.frame = None;
                EvaluationError::InvalidScene(error.to_string())
            })
    }

    fn output(
        &mut self,
        scene: &SceneFramePlans,
        mut context: FrameOutputContext,
    ) -> Result<FrameOutputContext, EvaluationError> {
        if self.frame.as_ref() != Some(&scene.scene.metadata.header) {
            return Err(EvaluationError::InvalidScene(
                "output allocation frame identity differs".into(),
            ));
        }
        let Some(PlanSlice::SceneBuffers(buffers)) = scene.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "output allocation geometry absent".into(),
            ));
        };
        let depth = context.beauty_depth_of_field
            || matches!(
                context.visualization,
                BufferVisualization::DepthFog | BufferVisualization::DepthOfField
            );
        let surface = matches!(
            context.visualization,
            BufferVisualization::SelectionIsolation | BufferVisualization::VectorMotionBlur
        );
        let diagnostic = !matches!(
            context.visualization,
            BufferVisualization::Beauty
                | BufferVisualization::LinearColor
                | BufferVisualization::Luminance
                | BufferVisualization::Alpha
        );
        let observation = self
            .renderer
            .prepare_project_output(ProjectOutputRequest {
                auxiliary: diagnostic
                    || context.beauty_depth_of_field
                    || context.motion_blur_requested,
                depth,
                depth_of_field: context.beauty_depth_of_field,
                motion: context.beauty_motion_blur,
                surface,
                visualizer: !matches!(context.visualization, BufferVisualization::Beauty)
                    && !depth
                    && !surface,
                draw_count: buffers.draws.len() as u32,
                vertex_count: buffers.vertex_count,
                auxiliary_budget_bytes: self.memory_budget_bytes / 2,
                motion_budget_bytes: self.memory_budget_bytes / 4,
            })
            .map_err(|error| {
                self.frame = None;
                EvaluationError::InvalidScene(error.to_string())
            })?;
        context.auxiliary_budget = AuxiliaryBudget {
            enabled: observation.auxiliary_enabled,
            depth_available: observation.depth_available,
            tier: observation.tier,
            estimated_bytes: observation.estimated_bytes,
            id_buffer_bytes: observation.id_buffer_bytes,
            motion_buffer_bytes: observation.motion_buffer_bytes,
            byte_budget: observation.byte_budget,
        };
        context.depth_attachments = DepthAttachments {
            scene: true,
            world_position: observation.auxiliary_enabled,
            transparent_world_position: observation.tier >= 1,
            front_layer_color: observation.tier >= 1,
            peeled_world_position: observation.tier >= 2,
            peeled_layer_color: observation.tier >= 2,
            motion_blur_source: false,
        };
        context.motion_resources_available = observation.motion_available;
        context.motion_binding_available = observation.motion_available;
        context.surface_resources_available = observation.surface_available;
        Ok(context)
    }
}
