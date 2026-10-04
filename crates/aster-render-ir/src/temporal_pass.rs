use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{BlobDescriptor, ElementType, IrError, ResourceHash, TemporalTextFormat};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TemporalTextPassesSlice {
    pub blob_index: u32,
    #[schemars(range(min = 1, max = 8192))]
    pub width: u32,
    #[schemars(range(min = 1, max = 8192))]
    pub height: u32,
    pub output: ResourceHash,
    #[schemars(length(max = 4096))]
    pub samples: Vec<ResourceHash>,
    pub sample_format: TemporalTextFormat,
    pub accumulation_format: TemporalTextFormat,
    pub output_format: TemporalTextFormat,
}

impl TemporalTextPassesSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        if !(1..=8192).contains(&self.width)
            || !(1..=8192).contains(&self.height)
            || self.samples.len() > 4096
            || self.sample_format != TemporalTextFormat::Rgba8UnormSrgb
            || self.accumulation_format != TemporalTextFormat::Rgba16Float
            || self.output_format != TemporalTextFormat::Rgba8UnormSrgb
            || blob.element_type != ElementType::U8
            || blob.byte_length as usize != 8 * (self.samples.len() + 1)
        {
            return Err(IrError::InvalidTemporalText(
                "pass layout or formats".to_owned(),
            ));
        }
        let mut seen = BTreeSet::new();
        for hash in std::iter::once(&self.output).chain(&self.samples) {
            hash.validate()?;
            if !seen.insert(hash) || !resources.contains(hash) {
                return Err(IrError::InvalidTemporalText(
                    "missing or duplicate pass resource".to_owned(),
                ));
            }
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if self.samples.len() > 4096 || bytes.len() != 8 * (self.samples.len() + 1) {
            return Err(IrError::InvalidTemporalText(
                "pass payload length".to_owned(),
            ));
        }
        let mut total = 0.0;
        let mut samples = 0.0;
        for (index, chunk) in bytes.chunks_exact(8).enumerate() {
            let lane: [u8; 8] = chunk
                .try_into()
                .map_err(|_| IrError::ElementCountMismatch)?;
            let weight = f64::from_le_bytes(lane);
            if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
                return Err(IrError::InvalidTemporalText(
                    "pass exposure weight".to_owned(),
                ));
            }
            total += weight;
            if index > 0 {
                samples += weight;
            }
        }
        if (total - 1.0).abs() > f64::EPSILON * (self.samples.len() + 2) as f64 * 4.0
            || samples > 1.0 + f64::EPSILON * (self.samples.len() + 1) as f64 * 4.0
        {
            return Err(IrError::InvalidTemporalText(
                "incomplete pass exposure".to_owned(),
            ));
        }
        Ok(())
    }
}
