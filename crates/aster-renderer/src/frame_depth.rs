use crate::{AuxiliaryPrimaryPlan, RenderError};
use aster_render_ir::{
    AuxiliaryStatus, DepthEffectMode, FinalDepthMode, FinalOutputRoute, OwnedFpln, PlanSlice,
    PostEffect, PostEffectInput, PostEffectStatus,
};

pub(crate) struct FrameDepth {
    pub auxiliary: Option<AuxiliaryPrimaryPlan>,
    pub tier: i8,
    pub inputs: [PostEffectInput; 6],
    pub uniforms: Vec<u8>,
    pub ready: bool,
}

impl FrameDepth {
    pub fn new(
        scene: &OwnedFpln,
        output: &OwnedFpln,
        auxiliary: Option<&OwnedFpln>,
        effect: Option<&OwnedFpln>,
        motion: bool,
    ) -> Result<Option<Self>, RenderError> {
        let Some(PlanSlice::FinalOutput(output)) = output.metadata.slices.first() else {
            return Err(RenderError::Invalid("depth output missing".into()));
        };
        let FinalOutputRoute::Depth { mode } = &output.route else {
            return Ok(None);
        };
        let effect = effect.ok_or_else(|| RenderError::Invalid("depth effect absent".into()))?;
        let Some(PlanSlice::PostEffect(slice)) = effect.metadata.slices.first() else {
            return Err(RenderError::Invalid("depth effect slice missing".into()));
        };
        let PostEffect::Depth {
            mode: effect_mode,
            inputs,
        } = &slice.effect
        else {
            return Err(RenderError::Invalid("depth output effect differs".into()));
        };
        if !matches!(
            (mode, effect_mode),
            (FinalDepthMode::DepthFog, DepthEffectMode::DepthFog)
                | (FinalDepthMode::DepthOfField, DepthEffectMode::DepthOfField)
        ) {
            return Err(RenderError::Invalid("depth output mode differs".into()));
        }
        let uniforms = effect.blob(slice.blob_index as usize)?;
        slice.validate_bytes(uniforms, &effect.metadata.header)?;
        let ready = slice.status == PostEffectStatus::Ready;
        let auxiliary = auxiliary.filter(|plan| !matches!(plan.metadata.slices.first(), Some(PlanSlice::Auxiliary(a)) if a.status == AuxiliaryStatus::Unavailable));
        let tier = auxiliary
            .and_then(|a| match a.metadata.slices.first() {
                Some(PlanSlice::Auxiliary(s)) => Some(s.tier),
                _ => None,
            })
            .map_or(-1, |tier| tier);
        if ready
            && (auxiliary.is_none()
                || inputs.iter().any(|input| match input {
                    PostEffectInput::TransparentWorldPosition
                    | PostEffectInput::FrontLayerColor => tier < 1,
                    PostEffectInput::PeeledWorldPosition | PostEffectInput::PeeledLayerColor => {
                        tier < 2
                    }
                    PostEffectInput::MotionBlur => !motion,
                    PostEffectInput::ObjectId | PostEffectInput::MotionVector => true,
                    _ => false,
                }))
        {
            return Err(RenderError::Invalid(
                "depth attachment tier unavailable".into(),
            ));
        }
        Ok(Some(Self {
            auxiliary: auxiliary
                .map(|a| AuxiliaryPrimaryPlan::new(scene, a))
                .transpose()?,
            tier,
            inputs: *inputs,
            uniforms: uniforms.to_vec(),
            ready,
        }))
    }

    pub fn required_bytes(&self) -> u64 {
        self.auxiliary.as_ref().map_or(128, |a| {
            a.required_bytes()
                + if self.tier >= 1 {
                    (a.vertices.len() + a.ids.len() + a.motion.len()) as u64
                } else {
                    0
                }
                + u64::from(a.size.width)
                    * u64::from(a.size.height)
                    * (if self.tier >= 1 { 16 } else { 0 } + if self.tier >= 2 { 20 } else { 0 })
                + 128
        })
    }
}
