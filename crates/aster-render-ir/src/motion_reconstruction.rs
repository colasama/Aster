use crate::{BlobDescriptor, ElementType, FrameHeaderSlice, FrameTime, IrError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MotionReconstructionSlice {
    pub blob_index: u32,
    pub status: MotionReconstructionStatus,
    pub inputs: [MotionReconstructionInput; 3],
    pub shutter_open: FrameTime,
    pub shutter_duration: FrameTime,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MotionReconstructionStatus {
    Ready,
    Skipped,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MotionReconstructionInput {
    Scene,
    MotionVector,
    ObjectId,
}
impl MotionReconstructionSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        self.shutter_open.validate()?;
        self.shutter_duration.validate()?;
        if self.shutter_duration.to_f64()? < 0.0
            || self.inputs
                != [
                    MotionReconstructionInput::Scene,
                    MotionReconstructionInput::MotionVector,
                    MotionReconstructionInput::ObjectId,
                ]
            || blob.element_type != ElementType::U8
            || blob.element_count != 32
            || blob.byte_length != 32
        {
            return Err(IrError::InvalidHeader(
                "motion reconstruction layout".to_owned(),
            ));
        }
        Ok(())
    }
    pub fn validate_bytes(&self, bytes: &[u8], header: &FrameHeaderSlice) -> Result<(), IrError> {
        if bytes.len() != 32 {
            return Err(IrError::InvalidHeader("motion uniform length".to_owned()));
        }
        let word = |offset: usize| {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        let width = f32::from_bits(word(0));
        let height = f32::from_bits(word(4));
        let samples = word(8);
        let adaptive = word(12);
        let radius = f32::from_bits(word(16));
        let position = f32::from_bits(word(20));
        if width != header.render_target.width as f32
            || height != header.render_target.height as f32
            || !(2..=64).contains(&samples)
            || !(samples..=128).contains(&adaptive)
            || !radius.is_finite()
            || !(0.0..=256.0).contains(&radius)
            || !position.is_finite()
            || !(-4.0..=4.0).contains(&position)
            || word(24) != 0
            || word(28) != 0
        {
            return Err(IrError::InvalidHeader("motion uniform values".to_owned()));
        }
        Ok(())
    }
}
