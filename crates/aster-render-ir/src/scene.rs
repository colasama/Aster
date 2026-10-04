use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{BlobDescriptor, CompositionIdentity, ElementType, IrError, ResourceHash};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaDrawBinding {
    Pending,
    Frame { hash: ResourceHash },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SceneMediaBinding {
    pub draw_index: u32,
    pub binding: MediaDrawBinding,
}

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
    pub media_bindings: Vec<SceneMediaBinding>,
}

impl SceneBuffersSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
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
        let mut previous = None;
        let referenced = resources.iter().collect::<std::collections::BTreeSet<_>>();
        for media in &self.media_bindings {
            if media.draw_index as usize >= self.draws.len()
                || previous.is_some_and(|index| index >= media.draw_index)
            {
                return Err(IrError::InvalidHeader(
                    "invalid media draw index".to_owned(),
                ));
            }
            previous = Some(media.draw_index);
            if let MediaDrawBinding::Frame { hash } = &media.binding {
                hash.validate()?;
                if !referenced.contains(hash) {
                    return Err(IrError::MissingResource(
                        "media frame is absent from plan resources".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }
}
