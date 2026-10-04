use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{BlobDescriptor, CompositionIdentity, ElementType, IrError};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SceneDrawRecord {
    pub instance_id: CompositionIdentity,
    pub resource_instance_id: CompositionIdentity,
    pub selection_id: CompositionIdentity,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub casts_shadow: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SceneBuffersSlice {
    pub blob_index: u32,
    pub vertex_count: u32,
    pub motion_vectors: bool,
    pub shadows_enabled: bool,
    pub draws: Vec<SceneDrawRecord>,
}

impl SceneBuffersSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        // Wire ABI: 148 lighting f32 lanes, 40 vertex lanes, optional vec2 motion.
        let length =
            u64::from(self.vertex_count) * (160 + if self.motion_vectors { 8 } else { 0 }) + 592;
        if blob.element_type != ElementType::F32Le || u64::from(blob.byte_length) != length {
            return Err(IrError::ElementCountMismatch);
        }
        let mut end = 0_u32;
        for draw in &self.draws {
            draw.instance_id.validate()?;
            draw.resource_instance_id.validate()?;
            draw.selection_id.validate()?;
            if draw.first_vertex != end {
                return Err(IrError::InvalidHeader(
                    "noncontiguous scene draw range".to_owned(),
                ));
            }
            end = draw
                .first_vertex
                .checked_add(draw.vertex_count)
                .ok_or(IrError::ArithmeticOverflow)?;
            if end > self.vertex_count {
                return Err(IrError::BlobRangeOutOfBounds);
            }
        }
        if end != self.vertex_count {
            return Err(IrError::InvalidHeader("scene draw coverage".to_owned()));
        }
        Ok(())
    }
}
