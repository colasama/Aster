use crate::{IrError, TexturePixelFormat};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextureEncoding {
    Png,
    Jpeg,
    Webp,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextureColorConversion {
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EncodedTextureDescriptor {
    pub encoding: TextureEncoding,
    pub format: TexturePixelFormat,
    pub color_space_conversion: TextureColorConversion,
}

impl EncodedTextureDescriptor {
    /// Framing admission does not replace bounded image decoding by the renderer.
    pub fn validate(&self, bytes: &[u8]) -> Result<(), IrError> {
        let signature = match self.encoding {
            TextureEncoding::Png => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
            TextureEncoding::Jpeg => bytes.starts_with(&[255, 216, 255]),
            TextureEncoding::Webp => {
                bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
            }
        };
        if !signature
            || bytes.len() > 64 * 1024 * 1024
            || self.format != TexturePixelFormat::Rgba8Unorm
        {
            return Err(IrError::InvalidResource(
                "invalid encoded texture payload or format".to_owned(),
            ));
        }
        Ok(())
    }
}
