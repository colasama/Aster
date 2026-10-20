use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    AuxiliaryStatus, DepthEffectMode, FinalBeautySource, FinalDepthMode, FinalOutputRoute,
    FinalSurfaceMode, FrameHeaderSlice, MotionReconstructionStatus, PlanSlice, PostEffect,
    PostEffectInput, SurfaceEffectMode,
};

pub struct FrameOutputPlans {
    pub auxiliary: Option<NativePlan>,
    pub motion: NativePlan,
    pub output: NativePlan,
    pub effect: Option<NativePlan>,
}
impl FrameOutputPlans {
    pub fn validate(&self) -> Result<FrameHeaderSlice, EvaluationError> {
        let header = &self.output.metadata.header;
        for plan in [
            self.auxiliary.as_ref(),
            Some(&self.motion),
            self.effect.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if &plan.metadata.header != header {
                return Err(EvaluationError::InvalidScene(
                    "output stage frame headers differ".into(),
                ));
            }
        }
        let Some(PlanSlice::FinalOutput(output)) = self.output.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing final output plan".into(),
            ));
        };
        let Some(PlanSlice::MotionReconstruction(motion)) = self.motion.metadata.slices.first()
        else {
            return Err(EvaluationError::InvalidScene(
                "missing motion reconstruction plan".into(),
            ));
        };
        let motion_ready = motion.status == MotionReconstructionStatus::Ready;
        if let Some(auxiliary) = &self.auxiliary {
            let Some(PlanSlice::Auxiliary(auxiliary)) = auxiliary.metadata.slices.first() else {
                return Err(EvaluationError::InvalidScene(
                    "missing auxiliary plan".into(),
                ));
            };
            if motion_ready && auxiliary.status != AuxiliaryStatus::Drawn {
                return Err(EvaluationError::InvalidScene(
                    "motion reconstruction requires drawn auxiliary data".into(),
                ));
            }
        }
        if matches!(
            output.route,
            FinalOutputRoute::Beauty {
                source: FinalBeautySource::MotionBlur
            }
        ) && !motion_ready
        {
            return Err(EvaluationError::InvalidScene(
                "output requires unavailable motion reconstruction".into(),
            ));
        }
        let needs_effect = matches!(
            output.route,
            FinalOutputRoute::Depth { .. } | FinalOutputRoute::Surface { .. }
        );
        if needs_effect != self.effect.is_some() {
            return Err(EvaluationError::InvalidScene(
                "output effect coverage differs from its route".into(),
            ));
        }
        if let Some(effect) = &self.effect {
            let Some(PlanSlice::PostEffect(effect)) = effect.metadata.slices.first() else {
                return Err(EvaluationError::InvalidScene(
                    "missing output effect".into(),
                ));
            };
            let matches = matches!(
                (&output.route, &effect.effect),
                (
                    FinalOutputRoute::Depth {
                        mode: FinalDepthMode::DepthFog
                    },
                    PostEffect::Depth {
                        mode: DepthEffectMode::DepthFog,
                        ..
                    }
                ) | (
                    FinalOutputRoute::Depth {
                        mode: FinalDepthMode::DepthOfField
                    },
                    PostEffect::Depth {
                        mode: DepthEffectMode::DepthOfField,
                        ..
                    }
                ) | (
                    FinalOutputRoute::Surface {
                        mode: FinalSurfaceMode::SelectionIsolation
                    },
                    PostEffect::Surface {
                        mode: SurfaceEffectMode::SelectionIsolation,
                        ..
                    }
                ) | (
                    FinalOutputRoute::Surface {
                        mode: FinalSurfaceMode::VectorMotionBlur
                    },
                    PostEffect::Surface {
                        mode: SurfaceEffectMode::VectorMotionBlur,
                        ..
                    }
                )
            );
            if !matches {
                return Err(EvaluationError::InvalidScene(
                    "output effect differs from its route".into(),
                ));
            }
            if let PostEffect::Depth { inputs, .. } = &effect.effect
                && inputs.contains(&PostEffectInput::MotionBlur)
                && !motion_ready
            {
                return Err(EvaluationError::InvalidScene(
                    "depth effect requires unavailable motion reconstruction".into(),
                ));
            }
        }
        Ok(header.clone())
    }
}
