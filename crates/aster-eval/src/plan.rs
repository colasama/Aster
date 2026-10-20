mod effect;
mod header;
mod lut;
mod material;
pub use material::MaterialTextureSettings;
mod output;
mod post_effect;
mod prepared_effect;
mod temporal_pass;
pub use post_effect::{DepthAttachments, DepthSettings, SurfacePostSettings};
pub use prepared_effect::{EffectPreparation, PreparedEffect, PreparedEffectProgram};
pub use temporal_pass::{TemporalRasterPass, TemporalRasterSample};
mod root;
pub use effect::{EffectContext, EffectExecutionPlan};
pub use lut::LutPlan;
pub use output::{BufferVisualization, FrameOutputSettings};
pub use root::{RootItemKind, RootSceneInput, RootStackItem};

use crate::EvaluationError;
use aster_render_ir::{
    BlobDescriptor, ContractLevel, DecodeLimits, ElementType, FplnCodec, FrameHeaderSlice,
    FramePlanSliceV1, PlanKind, PlanSlice, ResourceHash,
};
pub use header::FramePlanRequest;
use serde::Serialize;

/// Owned producer data. The codec validates every payload before resource publication.
#[derive(Clone, Debug, Serialize)]
pub struct NativePlan {
    pub metadata: FramePlanSliceV1,
    pub blobs: Vec<Vec<u8>>,
}

impl NativePlan {
    pub fn encode(&self, limits: &DecodeLimits) -> Result<Vec<u8>, EvaluationError> {
        FplnCodec::encode(
            self.metadata.clone(),
            &self.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            limits,
        )
        .map_err(|e| EvaluationError::InvalidScene(e.to_string()))
    }

    pub(crate) fn single(
        header: FrameHeaderSlice,
        contract: ContractLevel,
        slice: PlanSlice,
        element: ElementType,
        bytes: Vec<u8>,
        resources: Vec<ResourceHash>,
    ) -> Result<Self, EvaluationError> {
        let length = u32::try_from(bytes.len())
            .map_err(|_| EvaluationError::InvalidScene("plan payload exceeds wire range".into()))?;
        let metadata = FramePlanSliceV1 {
            kind: PlanKind::FramePlanSlice,
            plan_version: 1,
            contract_level: contract,
            renderer_plan_complete: contract == ContractLevel::FrameBundleSliceV1,
            header,
            resources,
            blobs: vec![BlobDescriptor {
                byte_offset: 0,
                byte_length: length,
                element_type: element,
                element_count: length / element.byte_width(),
            }],
            slices: vec![slice],
        };
        metadata
            .validate(&DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        metadata
            .validate_blob(0, &bytes)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        Ok(Self {
            metadata,
            blobs: vec![bytes],
        })
    }

    pub(crate) fn post(header: FrameHeaderSlice, time: f64) -> Result<Self, EvaluationError> {
        let uniforms = Self::post_uniforms(
            [header.render_target.width, header.render_target.height],
            time,
            0,
            false,
            0,
            false,
        );
        Self::single(
            header,
            ContractLevel::PostUniformsSliceV1,
            PlanSlice::PostProcessUniforms { blob_index: 0 },
            ElementType::F32Le,
            uniforms.iter().flat_map(|n| n.to_le_bytes()).collect(),
            Vec::new(),
        )
    }

    pub(crate) fn post_uniforms(
        size: [u32; 2],
        time: f64,
        count: usize,
        linear: bool,
        max_lod: u32,
        glow: bool,
    ) -> [f32; 24] {
        [
            size[0] as f32,
            size[1] as f32,
            time as f32,
            0.,
            1.,
            1.,
            0.,
            0.,
            0.,
            0.8,
            0.,
            0.,
            0.,
            0.,
            1.,
            0.,
            count as f32,
            u32::from(linear) as f32,
            max_lod as f32,
            u32::from(glow) as f32,
            0.18,
            0.,
            1.,
            0.,
        ]
    }
}
