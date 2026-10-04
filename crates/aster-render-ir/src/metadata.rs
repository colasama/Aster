use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecodeLimits, IrError, RationalFrameRate, RationalTime, ResourceHash};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    FramePlanSlice,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContractLevel {
    PostUniformsSliceV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AntiAliasing {
    Off,
    Fxaa,
    Ssaa2x,
    Ssaa4x,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum ColorPipeline {
    #[serde(rename = "linear-hdr-to-srgb-display")]
    LinearHdrToSrgbDisplay,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Extent2d {
    #[schemars(range(min = 1))]
    pub width: u32,
    #[schemars(range(min = 1))]
    pub height: u32,
}

impl Extent2d {
    pub fn validate(&self, limits: &DecodeLimits) -> Result<(), IrError> {
        if self.width == 0
            || self.height == 0
            || self.width > limits.max_dimension
            || self.height > limits.max_dimension
            || u64::from(self.width) * u64::from(self.height) > limits.max_pixels
        {
            return Err(IrError::LimitExceeded("target extent".to_owned()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrameHeaderSlice {
    #[schemars(range(max = 9007199254740991_u64))]
    pub project_revision: u64,
    #[schemars(length(min = 1, max = 256))]
    pub composition_id: String,
    pub time: RationalTime,
    pub frame_rate: RationalFrameRate,
    pub target: Extent2d,
    pub render_target: Extent2d,
    pub aa: AntiAliasing,
    pub color_pipeline: ColorPipeline,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ElementType {
    U8,
    U32Le,
    F32Le,
}

impl ElementType {
    pub fn byte_width(self) -> u32 {
        match self {
            Self::U8 => 1,
            Self::U32Le | Self::F32Le => 4,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobDescriptor {
    pub byte_offset: u32,
    #[schemars(range(min = 1))]
    pub byte_length: u32,
    pub element_type: ElementType,
    #[schemars(range(min = 1))]
    pub element_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanSlice {
    PostProcessUniforms { blob_index: u32 },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FramePlanSliceV1 {
    pub kind: PlanKind,
    #[schemars(extend("const" = 1))]
    pub plan_version: u32,
    pub contract_level: ContractLevel,
    #[schemars(extend("const" = false))]
    pub renderer_plan_complete: bool,
    pub header: FrameHeaderSlice,
    #[schemars(length(min = 1))]
    pub blobs: Vec<BlobDescriptor>,
    #[schemars(length(min = 1))]
    pub slices: Vec<PlanSlice>,
    pub resources: Vec<ResourceHash>,
}

impl FramePlanSliceV1 {
    pub fn validate(&self, limits: &DecodeLimits) -> Result<(), IrError> {
        limits.validate()?;
        if self.plan_version != 1 {
            return Err(IrError::InvalidHeader(
                "unsupported plan_version".to_owned(),
            ));
        }
        if self.renderer_plan_complete {
            return Err(IrError::IncompleteFramePlan);
        }
        if self.header.project_revision > 9_007_199_254_740_991 {
            return Err(IrError::InvalidSafeInteger);
        }
        if self.header.composition_id.is_empty()
            || self.header.composition_id.len() > 256
            || self.header.composition_id.contains('\0')
        {
            return Err(IrError::InvalidHeader(
                "invalid composition identifier".to_owned(),
            ));
        }
        self.header.time.validate()?;
        self.header.frame_rate.validate()?;
        self.header.target.validate(limits)?;
        self.header.render_target.validate(limits)?;
        if self.blobs.is_empty() || self.slices.is_empty() || self.blobs.len() != self.slices.len()
        {
            return Err(IrError::BlobCountMismatch);
        }
        if self.blobs.len() > limits.max_blobs
            || self.slices.len() > limits.max_slices
            || self.resources.len() > limits.max_resource_references
        {
            return Err(IrError::LimitExceeded("metadata array count".to_owned()));
        }
        let mut referenced = BTreeSet::new();
        for slice in &self.slices {
            let PlanSlice::PostProcessUniforms { blob_index } = slice;
            let blob = self
                .blobs
                .get(*blob_index as usize)
                .ok_or(IrError::BlobCountMismatch)?;
            if !referenced.insert(*blob_index) {
                return Err(IrError::BlobCountMismatch);
            }
            if blob.element_type != ElementType::F32Le {
                return Err(IrError::BlobTypeMismatch);
            }
            if blob.byte_length != 96 || blob.element_count != 24 {
                return Err(IrError::ElementCountMismatch);
            }
        }
        for blob in &self.blobs {
            if blob.element_count == 0
                || blob
                    .element_count
                    .checked_mul(blob.element_type.byte_width())
                    .ok_or(IrError::ArithmeticOverflow)?
                    != blob.byte_length
            {
                return Err(IrError::ElementCountMismatch);
            }
        }
        for hash in &self.resources {
            hash.validate()?;
        }
        if self.resources.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(IrError::InvalidResource(
                "resource references must be unique and sorted".to_owned(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_uniforms(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != 96 {
            return Err(IrError::ElementCountMismatch);
        }
        let mut lanes = [0.0_f32; 24];
        for (index, chunk) in bytes.chunks_exact(4).enumerate() {
            lanes[index] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        if lanes.iter().any(|value| !value.is_finite()) {
            return Err(IrError::InvalidPostUniforms("nonfinite lane".to_owned()));
        }
        if lanes[0] != self.header.render_target.width as f32
            || lanes[1] != self.header.render_target.height as f32
        {
            return Err(IrError::InvalidPostUniforms(
                "render dimensions differ from metadata".to_owned(),
            ));
        }
        if lanes[16].fract() != 0.0
            || !(0.0..=64.0).contains(&lanes[16])
            || ![0.0, 1.0].contains(&lanes[17])
            || ![0.0, 1.0].contains(&lanes[19])
            || lanes[23].to_bits() != 0
        {
            return Err(IrError::InvalidPostUniforms(
                "operation count, flags or reserved lane".to_owned(),
            ));
        }
        Ok(())
    }
}
