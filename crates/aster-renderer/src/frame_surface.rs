use aster_render_ir::{
    AuxiliaryStatus, FinalBeautySource, FinalOutputRoute, FinalSurfaceMode, OwnedFpln, PlanSlice,
    PostEffect, RootTextureReference, SurfaceEffectMode,
};

use crate::{AuxiliaryPrimaryPlan, RenderError, SurfacePostPlan};

pub(crate) struct FrameSurface {
    pub effect: SurfacePostPlan,
    pub auxiliary: Option<AuxiliaryPrimaryPlan>,
}

impl FrameSurface {
    pub fn new(
        scene: &OwnedFpln,
        output: &OwnedFpln,
        auxiliary: Option<&OwnedFpln>,
        effect: Option<&OwnedFpln>,
    ) -> Result<Option<Self>, RenderError> {
        let Some(PlanSlice::FinalOutput(output)) = output.metadata.slices.first() else {
            return Err(RenderError::Invalid("output stage missing".into()));
        };
        let FinalOutputRoute::Surface { mode } = &output.route else {
            if output.route
                != (FinalOutputRoute::Beauty {
                    source: FinalBeautySource::Scene,
                })
                || auxiliary.is_some()
                || effect.is_some()
            {
                return Err(RenderError::Unsupported(
                    "non-surface diagnostic output or auxiliary beauty stage".into(),
                ));
            }
            return Ok(None);
        };
        let effect =
            effect.ok_or_else(|| RenderError::Invalid("surface output effect missing".into()))?;
        let Some(PlanSlice::PostEffect(slice)) = effect.metadata.slices.first() else {
            return Err(RenderError::Invalid("post effect missing".into()));
        };
        if !matches!(
            (&slice.effect, mode),
            (
                PostEffect::Surface {
                    mode: SurfaceEffectMode::SelectionIsolation,
                    ..
                },
                FinalSurfaceMode::SelectionIsolation
            ) | (
                PostEffect::Surface {
                    mode: SurfaceEffectMode::VectorMotionBlur,
                    ..
                },
                FinalSurfaceMode::VectorMotionBlur
            )
        ) {
            return Err(RenderError::Invalid(
                "surface output mode differs from effect".into(),
            ));
        }
        let effect = SurfacePostPlan::new(effect)?;
        let auxiliary = auxiliary.filter(|plan| !matches!(plan.metadata.slices.first(), Some(PlanSlice::Auxiliary(slice)) if slice.status == AuxiliaryStatus::Unavailable))
            .map(|plan| AuxiliaryPrimaryPlan::new(scene, plan)).transpose()?;
        if effect.ready && auxiliary.is_none() {
            return Err(RenderError::Invalid(
                "ready surface output requires auxiliary attachments".into(),
            ));
        }
        Ok(Some(Self { effect, auxiliary }))
    }

    pub fn validate_resources(
        &self,
        scene: &crate::scene_input::SceneInput,
        surfaces: &crate::surface_plan::SurfacePlan,
    ) -> Result<(), RenderError> {
        if let Some(auxiliary) = &self.auxiliary {
            for draw in &auxiliary.draws {
                if !scene.root.draws.iter().any(|root| {
                    root.instance_id == draw.instance_id
                        && root.first_vertex == draw.first_vertex
                        && root.vertex_count == draw.vertex_count
                        && root.texture == draw.texture
                }) {
                    return Err(RenderError::Invalid(
                        "auxiliary draw differs from root geometry".into(),
                    ));
                }
                match &draw.texture {
                    RootTextureReference::None => {}
                    RootTextureReference::Media { hash } if scene.images.contains_key(hash) => {}
                    RootTextureReference::Surface { instance_id }
                        if surfaces
                            .bindings
                            .contains_key(&crate::surface_plan::SurfacePlan::key(instance_id)) => {}
                    _ => {
                        return Err(RenderError::Invalid(
                            "auxiliary image or surface binding missing".into(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}
