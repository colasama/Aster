use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    ContractLevel, ElementType, FrameHeaderSlice, PlanSlice, ResourceHash, TemporalTextFormat,
    TemporalTextPassesSlice,
};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct TemporalRasterSample {
    pub hash: ResourceHash,
    pub weight: f64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct TemporalRasterPass {
    pub width: u32,
    pub height: u32,
    pub output: ResourceHash,
    pub samples: Vec<TemporalRasterSample>,
}
impl TemporalRasterPass {
    pub fn plan(&self, header: FrameHeaderSlice) -> Result<NativePlan, EvaluationError> {
        if self.samples.len() > 4096
            || self
                .samples
                .iter()
                .any(|s| !s.weight.is_finite() || !(0.0..=1.0).contains(&s.weight))
        {
            return Err(EvaluationError::InvalidScene(
                "temporal raster sample budget or weight".into(),
            ));
        }
        let total: f64 = self.samples.iter().map(|s| s.weight).sum();
        if total > 1.0 + f64::EPSILON * (self.samples.len() + 1) as f64 * 4.0 {
            return Err(EvaluationError::InvalidScene(
                "temporal raster exposure exceeds one".into(),
            ));
        }
        let bytes = std::iter::once((1.0 - total).max(0.0))
            .chain(self.samples.iter().map(|s| s.weight))
            .flat_map(f64::to_le_bytes)
            .collect();
        let mut resources: Vec<_> = std::iter::once(self.output.clone())
            .chain(self.samples.iter().map(|s| s.hash.clone()))
            .collect();
        resources.sort();
        NativePlan::single(
            header,
            ContractLevel::TemporalTextPassesSliceV1,
            PlanSlice::TemporalTextPasses(TemporalTextPassesSlice {
                blob_index: 0,
                width: self.width,
                height: self.height,
                output: self.output.clone(),
                samples: self.samples.iter().map(|s| s.hash.clone()).collect(),
                sample_format: TemporalTextFormat::Rgba8UnormSrgb,
                accumulation_format: TemporalTextFormat::Rgba16Float,
                output_format: TemporalTextFormat::Rgba8UnormSrgb,
            }),
            ElementType::U8,
            bytes,
            resources,
        )
    }
}
