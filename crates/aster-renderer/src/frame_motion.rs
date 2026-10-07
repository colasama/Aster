use aster_render_ir::{
    AuxiliaryStatus, Extent2d, MotionReconstructionStatus, OwnedFpln, PlanSlice,
};

use crate::{AuxiliaryPrimaryPlan, RenderError};

pub(crate) struct FrameMotion {
    pub size: Extent2d,
    pub tiles: Extent2d,
    pub uniforms: Vec<u8>,
    pub auxiliary: AuxiliaryPrimaryPlan,
}

impl FrameMotion {
    pub fn new(
        scene: &OwnedFpln,
        motion: &OwnedFpln,
        auxiliary: Option<&OwnedFpln>,
    ) -> Result<Option<Self>, RenderError> {
        let Some(PlanSlice::MotionReconstruction(slice)) = motion.metadata.slices.first() else {
            return Err(RenderError::Invalid("motion stage missing".into()));
        };
        let uniforms = motion.blob(slice.blob_index as usize)?;
        slice.validate_bytes(uniforms, &motion.metadata.header)?;
        if slice.status == MotionReconstructionStatus::Skipped {
            return Ok(None);
        }
        let auxiliary = auxiliary
            .ok_or_else(|| RenderError::Invalid("motion requires auxiliary inputs".into()))?;
        if !matches!(auxiliary.metadata.slices.first(), Some(PlanSlice::Auxiliary(value))
            if value.status != AuxiliaryStatus::Unavailable && value.motion)
        {
            return Err(RenderError::Invalid("motion vectors unavailable".into()));
        }
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
        let size = motion.metadata.header.render_target;
        Ok(Some(Self {
            size,
            tiles: Extent2d {
                width: size.width.div_ceil(extent),
                height: size.height.div_ceil(extent),
            },
            uniforms: uniforms.to_vec(),
            auxiliary: AuxiliaryPrimaryPlan::new(scene, auxiliary)?,
        }))
    }

    pub fn required_bytes(&self) -> u64 {
        self.auxiliary.required_bytes()
            + u64::from(self.size.width) * u64::from(self.size.height) * 8
            + u64::from(self.tiles.width) * u64::from(self.tiles.height) * 16
            + 32
    }
}
