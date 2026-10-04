use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{BlobDescriptor, CompositionIdentity, ElementType, FrameHeaderSlice, IrError};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum TemporalTextFormat {
    #[serde(rename = "rgba8unorm-srgb")]
    Rgba8UnormSrgb,
    #[serde(rename = "rgba16float")]
    Rgba16Float,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TemporalTextSamplesSlice {
    pub blob_index: u32,
    pub resource_instance_id: CompositionIdentity,
    #[schemars(range(min = 1, max = 4096))]
    pub sample_count: u32,
    #[schemars(range(max = 4096))]
    pub unique_sample_count: u32,
    pub exposure_only: bool,
    pub sample_format: TemporalTextFormat,
    pub accumulation_format: TemporalTextFormat,
    pub resolve_format: TemporalTextFormat,
}

impl TemporalTextSamplesSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        self.resource_instance_id.validate()?;
        if !(1..=4096).contains(&self.sample_count)
            || self.unique_sample_count > self.sample_count
            || self.sample_format != TemporalTextFormat::Rgba8UnormSrgb
            || self.accumulation_format != TemporalTextFormat::Rgba16Float
            || self.resolve_format != TemporalTextFormat::Rgba8UnormSrgb
            || blob.element_type != ElementType::U8
            || blob.byte_length != 16 + self.unique_sample_count * 24
        {
            return Err(IrError::InvalidTemporalText("layout or formats".to_owned()));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8], header: &FrameHeaderSlice) -> Result<(), IrError> {
        if self.unique_sample_count > 4096
            || bytes.len() != 16 + self.unique_sample_count as usize * 24
        {
            return Err(IrError::InvalidTemporalText("payload length".to_owned()));
        }
        let mut values = Vec::with_capacity(bytes.len() / 8);
        for chunk in bytes.chunks_exact(8) {
            let lane: [u8; 8] = chunk
                .try_into()
                .map_err(|_| IrError::ElementCountMismatch)?;
            values.push(f64::from_le_bytes(lane));
        }
        if values[0].to_bits() != header.time.to_f64()?.to_bits()
            || !values[1].is_finite()
            || !(0.0..=1.0).contains(&values[1])
        {
            return Err(IrError::InvalidTemporalText(
                "frame time or transparent weight".to_owned(),
            ));
        }
        let mut total = values[1];
        for sample in values[2..].chunks_exact(3) {
            if !sample[0].is_finite()
                || !sample[1].is_finite()
                || !(0.0..=1.0).contains(&sample[1])
                || !sample[2].is_finite()
                || sample[2].fract() != 0.0
                || sample[2].abs() > 9_007_199_254_740_991.0
            {
                return Err(IrError::InvalidTemporalText(
                    "sample time, weight or bucket".to_owned(),
                ));
            }
            total += sample[1];
        }
        if (total - 1.0).abs() > f64::EPSILON * f64::from(self.unique_sample_count + 1) * 4.0 {
            return Err(IrError::InvalidTemporalText(
                "incomplete shutter exposure".to_owned(),
            ));
        }
        Ok(())
    }
}
