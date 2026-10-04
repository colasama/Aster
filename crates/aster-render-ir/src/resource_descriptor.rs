use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    BufferResourceDescriptor, IrError, MediaFrameDescriptor, MediaSourceDescriptor, ResourceKind,
};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum ResourceDescriptor {
    Buffer(BufferResourceDescriptor),
    MediaSource(MediaSourceDescriptor),
    MediaFrame(MediaFrameDescriptor),
}

impl ResourceDescriptor {
    pub fn validate(&self, kind: ResourceKind, bytes: &[u8]) -> Result<(), IrError> {
        match (self, kind) {
            (Self::Buffer(descriptor), ResourceKind::Buffer) => descriptor.validate(bytes),
            (Self::MediaSource(descriptor), ResourceKind::MediaSource) if bytes.is_empty() => {
                descriptor.validate()
            }
            (Self::MediaFrame(descriptor), ResourceKind::MediaFrame) if bytes.is_empty() => {
                descriptor.validate()
            }
            _ => Err(IrError::InvalidResource(
                "resource kind, descriptor or payload mismatch".to_owned(),
            )),
        }
    }
}
