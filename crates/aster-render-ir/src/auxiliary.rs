use crate::{
    BlobDescriptor, CompositionIdentity, ElementType, IrError, ResourceHash, RootTextureReference,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuxiliaryDraw {
    pub instance_id: CompositionIdentity,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub texture: RootTextureReference,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuxiliaryStatus {
    Unavailable,
    Cleared,
    Drawn,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuxiliarySlice {
    pub blob_index: u32,
    pub status: AuxiliaryStatus,
    pub tier: i8,
    pub vertex_count: u32,
    pub motion: bool,
    pub draws: Vec<AuxiliaryDraw>,
    pub generators: Vec<CompositionIdentity>,
}
impl AuxiliarySlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        if !(-1..=2).contains(&self.tier)
            || self.draws.len() > 65536
            || self.generators.len() > 65536
            || (self.status != AuxiliaryStatus::Drawn
                && (self.vertex_count != 0
                    || self.motion
                    || !self.draws.is_empty()
                    || !self.generators.is_empty()))
            || (self.status == AuxiliaryStatus::Unavailable && self.tier != -1)
        {
            return Err(IrError::InvalidHeader(
                "auxiliary outcome or counts".to_owned(),
            ));
        }
        let mut hashes = BTreeSet::new();
        for draw in &self.draws {
            draw.instance_id.validate()?;
            if draw.first_vertex > self.vertex_count
                || draw.vertex_count > self.vertex_count - draw.first_vertex
            {
                return Err(IrError::InvalidHeader("auxiliary vertex range".to_owned()));
            }
            match &draw.texture {
                RootTextureReference::None => {}
                RootTextureReference::Pending => {
                    return Err(IrError::InvalidHeader(
                        "unresolved auxiliary texture".to_owned(),
                    ));
                }
                RootTextureReference::Media { hash } => {
                    hash.validate()?;
                    hashes.insert(hash.clone());
                }
                RootTextureReference::Surface { instance_id }
                | RootTextureReference::RasterCache { instance_id } => instance_id.validate()?,
            }
        }
        for id in &self.generators {
            id.validate()?;
        }
        if resources.len() != hashes.len() || resources.iter().any(|h| !hashes.contains(h)) {
            return Err(IrError::MissingResource(
                "auxiliary media closure".to_owned(),
            ));
        }
        let bytes = self.draws.len() as u64 * 8
            + if self.motion {
                u64::from(self.vertex_count) * 8
            } else {
                0
            };
        let bytes = bytes.max(4);
        if blob.element_type != ElementType::U8
            || u64::from(blob.element_count) != bytes
            || u64::from(blob.byte_length) != bytes
        {
            return Err(IrError::InvalidHeader(
                "auxiliary payload layout".to_owned(),
            ));
        }
        Ok(())
    }
    pub fn validate_bytes(&self, bytes: &[u8]) -> Result<(), IrError> {
        let id_bytes = self.draws.len() * 8;
        let expected = id_bytes as u64
            + if self.motion {
                u64::from(self.vertex_count) * 8
            } else {
                0
            };
        if bytes.len() as u64 != expected.max(4) {
            return Err(IrError::InvalidHeader(
                "auxiliary payload length".to_owned(),
            ));
        }
        if expected == 0 {
            if bytes.iter().any(|value| *value != 0) {
                return Err(IrError::InvalidHeader("empty auxiliary padding".to_owned()));
            }
            return Ok(());
        }
        for chunk in bytes[id_bytes..].chunks_exact(4) {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if !value.is_finite() || !(-8.0..=8.0).contains(&value) {
                return Err(IrError::InvalidHeader(
                    "auxiliary motion displacement".to_owned(),
                ));
            }
        }
        Ok(())
    }
}
