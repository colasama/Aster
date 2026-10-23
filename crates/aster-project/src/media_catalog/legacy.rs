use crate::{ProjectError, ProjectMediaStorage};
use aster_types::editor::Source;
use base64::Engine;
use serde::Deserialize;

/// Historical source identity describes a locator and dimensions, independently of frozen bytes.
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LegacyMediaLocator {
    Inline { prefix: String },
    Text { value: String },
}

impl LegacyMediaLocator {
    pub(super) fn verify(
        &self,
        source: &Source,
        storage: &ProjectMediaStorage,
        bytes: &[u8],
    ) -> Result<(), ProjectError> {
        if matches!(storage, ProjectMediaStorage::External { .. }) {
            return Err(ProjectError::InvalidMedia(
                "legacy media requires authenticated frozen storage",
            ));
        }
        let locator = match self {
            Self::Inline { prefix } => {
                if prefix.len() > 4096
                    || !prefix.starts_with("data:")
                    || !prefix.ends_with(";base64,")
                {
                    return Err(ProjectError::InvalidMedia("invalid legacy inline prefix"));
                }
                format!(
                    "{prefix}{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            }
            Self::Text { value } => {
                if value.is_empty() || value.len() > 16384 {
                    return Err(ProjectError::InvalidMedia("invalid legacy source locator"));
                }
                value.clone()
            }
        };
        let numbers = [&source.width, &source.height, &source.duration]
            .map(|value| value.value().and_then(|n| n.as_f64()).unwrap_or(0.0));
        let mut left = 0x811c9dc5_u32;
        let mut right = 0x9e3779b9_u32;
        let mut length = 0;
        for part in [
            source.mime_type.as_str(),
            locator.as_str(),
            ryu_js::Buffer::new().format(numbers[0]),
            ryu_js::Buffer::new().format(numbers[1]),
            ryu_js::Buffer::new().format(numbers[2]),
        ] {
            for code in part.encode_utf16().chain(std::iter::once(0)) {
                left = (left ^ u32::from(code)).wrapping_mul(0x01000193);
                right = (right ^ u32::from(code)).wrapping_mul(0x85ebca6b);
                length += 1;
            }
        }
        if source.content_identity != format!("fnv64:{left:08x}{right:08x}:{length}") {
            return Err(ProjectError::InvalidMedia(
                "legacy source locator identity differs",
            ));
        }
        Ok(())
    }
}
