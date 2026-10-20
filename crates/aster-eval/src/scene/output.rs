use super::{
    AuxiliaryBudget, EvaluatedSceneLayer, RenderIdentity, RootResourceBindings, SceneFramePlans,
    SceneProject,
};
use crate::{
    BufferVisualization, DepthAttachments, DepthSettings, EvaluationError, FrameOutputPlans,
    FrameOutputSettings, MotionSettings, SurfacePostSettings,
};
use aster_render_ir::{
    AuxiliaryStatus, CompositionIdentity, DepthEffectMode, FinalDepthMode, FinalOutputRoute,
    FinalSurfaceMode, MotionReconstructionStatus, PlanSlice, SurfaceEffectMode,
};
use serde::Deserialize;

/// Authoring decisions and observed allocations are supplied separately from generated plans.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOutputContext {
    pub visualization: BufferVisualization,
    pub beauty_depth_of_field: bool,
    pub beauty_motion_blur: bool,
    pub motion_blur_requested: bool,
    pub selected_layer_id: Option<String>,
    pub generator_selection_ids: Vec<String>,
    pub auxiliary_generators: Vec<String>,
    pub auxiliary_budget: AuxiliaryBudget,
    pub motion_resources_available: bool,
    pub motion_binding_available: bool,
    pub depth_settings: DepthSettings,
    pub depth_attachments: DepthAttachments,
    pub surface_resources_available: bool,
}

impl SceneProject {
    pub fn plan_frame_output(
        &self,
        scene: &SceneFramePlans,
        layers: &[EvaluatedSceneLayer],
        bindings: &RootResourceBindings,
        context: &FrameOutputContext,
    ) -> Result<FrameOutputPlans, EvaluationError> {
        let header = &scene.scene.metadata.header;
        let CompositionIdentity::Unicode(id) = &header.composition_id else {
            return Err(EvaluationError::InvalidScene(
                "native output composition identity".into(),
            ));
        };
        let composition = &self.project.compositions[self.composition_index(id)?];
        let Some(PlanSlice::SceneBuffers(buffers)) = scene.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "output scene buffers are absent".into(),
            ));
        };
        let needs_auxiliary = !matches!(
            context.visualization,
            BufferVisualization::Beauty
                | BufferVisualization::LinearColor
                | BufferVisualization::Luminance
                | BufferVisualization::Alpha
        ) || context.beauty_depth_of_field
            || context.motion_blur_requested;
        let auxiliary = if needs_auxiliary {
            Some(self.plan_auxiliary(
                scene,
                layers,
                bindings,
                &context.auxiliary_budget,
                if context.beauty_motion_blur {
                    &[]
                } else {
                    &context.auxiliary_generators
                },
            )?)
        } else {
            None
        };
        let auxiliary_slice = auxiliary
            .as_ref()
            .and_then(|p| match p.metadata.slices.first() {
                Some(PlanSlice::Auxiliary(slice)) => Some(slice),
                _ => None,
            });
        let auxiliary_valid = auxiliary_slice.is_none_or(|s| s.status == AuxiliaryStatus::Drawn);
        let settings = MotionSettings::normalize(composition.motion_blur.value());
        let time = header
            .time
            .to_f64()
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let rate = Self::number(&composition.frame_rate.numerator)?
            / Self::number(&composition.frame_rate.denominator)?;
        let width = Self::number(&composition.width)?;
        let interval = settings.interval(time, rate, None);
        let motion = settings.reconstruction(
            header.clone(),
            &interval,
            context.beauty_motion_blur && auxiliary_valid && buffers.motion_vectors,
            context.motion_resources_available,
            width,
        )?;
        let motion_ready = matches!(motion.metadata.slices.first(), Some(PlanSlice::MotionReconstruction(s)) if s.status == MotionReconstructionStatus::Ready);
        let output = FrameOutputSettings {
            visualization: context.visualization,
            auxiliary_valid,
            beauty_depth_of_field: context.beauty_depth_of_field,
            motion_blur_valid: motion_ready,
            motion_blur_binding_available: context.motion_binding_available,
        }
        .build(header.clone())?;
        let Some(PlanSlice::FinalOutput(final_output)) = output.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "final output route is absent".into(),
            ));
        };
        let effect = match &final_output.route {
            FinalOutputRoute::Depth { mode } => {
                let mut attachments = context.depth_attachments.clone();
                if context.beauty_depth_of_field {
                    attachments.motion_blur_source = motion_ready;
                }
                Some(context.depth_settings.build(
                    header.clone(),
                    match mode {
                        FinalDepthMode::DepthFog => DepthEffectMode::DepthFog,
                        FinalDepthMode::DepthOfField => DepthEffectMode::DepthOfField,
                    },
                    &attachments,
                )?)
            }
            FinalOutputRoute::Surface { mode } => {
                let selected = context
                    .selected_layer_id
                    .as_deref()
                    .filter(|id| !id.is_empty());
                let selected = selected.filter(|id| {
                    context.generator_selection_ids.iter().any(|s| s == id)
                        || buffers
                            .draws
                            .iter()
                            .any(|d| d.selection_id == CompositionIdentity::Unicode((*id).into()))
                });
                Some(
                    SurfacePostSettings {
                        render_id: selected.map_or(0.0, |id| f64::from(RenderIdentity::encode(id))),
                        motion_shutter_scale: if auxiliary_slice.is_some_and(|s| s.motion) {
                            1.0
                        } else {
                            0.0
                        },
                        resources_available: context.surface_resources_available,
                    }
                    .build(
                        header.clone(),
                        match mode {
                            FinalSurfaceMode::SelectionIsolation => {
                                SurfaceEffectMode::SelectionIsolation
                            }
                            FinalSurfaceMode::VectorMotionBlur => {
                                SurfaceEffectMode::VectorMotionBlur
                            }
                        },
                    )?,
                )
            }
            _ => None,
        };
        let plans = FrameOutputPlans {
            auxiliary,
            motion,
            output,
            effect,
        };
        plans.validate()?;
        Ok(plans)
    }
}
