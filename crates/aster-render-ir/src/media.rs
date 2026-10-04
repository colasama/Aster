use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{CompositionIdentity, FrameTime, IrError, RasterSample, ResourceHash};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Sequence,
    Video,
    Raster,
}

/// The job broker resolves this identity; a descriptor never grants filesystem access.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaSourceDescriptor {
    pub source_id: CompositionIdentity,
    #[schemars(length(min = 1))]
    pub content_identity: String,
    #[schemars(length(min = 1))]
    pub authorization_scope: String,
    pub media_kind: MediaKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaSample {
    Image,
    Raster(RasterSample),
    Sequence {
        #[schemars(range(min = -9007199254740991_i64, max = 9007199254740991_i64))]
        frame: i64,
        #[schemars(length(min = 1))]
        file_identity: String,
    },
    Video {
        requested_time: FrameTime,
        uploaded_time: FrameTime,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum MediaTextureFormat {
    #[serde(rename = "rgba8unorm-srgb")]
    Rgba8UnormSrgb,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaFrameDescriptor {
    pub source: ResourceHash,
    pub sample: MediaSample,
    #[schemars(range(min = 1, max = 16384))]
    pub width: u32,
    #[schemars(range(min = 1, max = 16384))]
    pub height: u32,
    pub format: MediaTextureFormat,
}

impl MediaSourceDescriptor {
    pub fn validate(&self) -> Result<(), IrError> {
        self.source_id.validate()?;
        if self.content_identity.is_empty() || self.authorization_scope.is_empty() {
            return Err(IrError::InvalidResource(
                "empty media source identity".to_owned(),
            ));
        }
        Ok(())
    }
}

impl MediaFrameDescriptor {
    pub fn validate(&self) -> Result<(), IrError> {
        self.source.validate()?;
        if self.width == 0 || self.height == 0 || self.width > 16384 || self.height > 16384 {
            return Err(IrError::InvalidResource("invalid media extent".to_owned()));
        }
        match &self.sample {
            MediaSample::Image => Ok(()),
            MediaSample::Raster(sample) => sample.bounds().map(|_| ()),
            MediaSample::Sequence {
                frame,
                file_identity,
            } => {
                if file_identity.is_empty() {
                    return Err(IrError::InvalidResource(
                        "empty sequence member identity".to_owned(),
                    ));
                }
                if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(frame) {
                    return Err(IrError::InvalidSafeInteger);
                }
                Ok(())
            }
            MediaSample::Video {
                requested_time,
                uploaded_time,
            } => {
                requested_time.validate()?;
                uploaded_time.validate()
            }
        }
    }

    pub fn validate_source(&self, source: &MediaSourceDescriptor) -> Result<(), IrError> {
        if !matches!(
            (&self.sample, source.media_kind),
            (MediaSample::Image, MediaKind::Image)
                | (MediaSample::Sequence { .. }, MediaKind::Sequence)
                | (MediaSample::Video { .. }, MediaKind::Video)
                | (MediaSample::Raster(_), MediaKind::Raster)
        ) {
            return Err(IrError::ResourceConflict);
        }
        Ok(())
    }
}
