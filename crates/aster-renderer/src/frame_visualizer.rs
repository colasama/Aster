use crate::{AuxiliaryPrimaryPlan, RenderError};
use aster_render_ir::{
    AuxiliaryStatus, FinalOutputRoute, FinalVisualization, OwnedFpln, PlanSlice,
};

pub(crate) struct FrameVisualizer {
    pub pipeline: usize,
    pub attachment: Option<usize>,
    pub uniforms: [u8; 16],
    pub auxiliary: Option<AuxiliaryPrimaryPlan>,
}

impl FrameVisualizer {
    pub fn new(
        scene: &OwnedFpln,
        output: &OwnedFpln,
        auxiliary: Option<&OwnedFpln>,
        effect: Option<&OwnedFpln>,
    ) -> Result<Option<Self>, RenderError> {
        let Some(PlanSlice::FinalOutput(output)) = output.metadata.slices.first() else {
            return Err(RenderError::Invalid("visualizer output missing".into()));
        };
        let FinalOutputRoute::Visualizer { mode } = &output.route else {
            return Ok(None);
        };
        if effect.is_some() {
            return Err(RenderError::Invalid("visualizer has a post effect".into()));
        }
        let (pipeline, attachment, value) = match mode {
            FinalVisualization::LinearColor => (0, None, 0_u32),
            FinalVisualization::Luminance => (0, None, 1),
            FinalVisualization::Alpha => (0, None, 2),
            FinalVisualization::Normal => (1, Some(0), 0),
            FinalVisualization::ObjectId => (2, Some(1), 0),
            FinalVisualization::MaterialId => (2, Some(2), 0),
            FinalVisualization::WorldPosition => (1, Some(3), 1),
            FinalVisualization::MotionVector => (1, Some(4), 2),
        };
        let auxiliary = auxiliary
            .filter(|a| !matches!(a.metadata.slices.first(), Some(PlanSlice::Auxiliary(s)) if s.status == AuxiliaryStatus::Unavailable))
            .map(|a| AuxiliaryPrimaryPlan::new(scene, a)).transpose()?;
        if attachment.is_some() && auxiliary.is_none() {
            return Err(RenderError::Invalid(
                "visualizer auxiliary source absent".into(),
            ));
        }
        let mut uniforms = [0; 16];
        if pipeline == 0 {
            uniforms[..4].copy_from_slice(&value.to_le_bytes());
        } else {
            let size = scene.metadata.header.render_target;
            let range = size.width.max(size.height) as f32;
            uniforms[..4].copy_from_slice(&(-range).to_le_bytes());
            uniforms[4..8].copy_from_slice(&(1.0 / (range * 2.0)).to_le_bytes());
            uniforms[8..12].copy_from_slice(&value.to_le_bytes());
        }
        Ok(Some(Self {
            pipeline,
            attachment,
            uniforms,
            auxiliary,
        }))
    }

    pub fn required_bytes(&self) -> u64 {
        16 + self
            .auxiliary
            .as_ref()
            .map_or(0, AuxiliaryPrimaryPlan::required_bytes)
    }
}
