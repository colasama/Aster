use crate::IrError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum TextureDimension {
    #[serde(rename = "2d")]
    D2,
    #[serde(rename = "3d")]
    D3,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum TexturePixelFormat {
    #[serde(rename = "rgba8unorm")]
    Rgba8Unorm,
    #[serde(rename = "rgba16float")]
    Rgba16Float,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TexturePixelsDescriptor {
    pub dimension: TextureDimension,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub format: TexturePixelFormat,
}

impl TexturePixelsDescriptor {
    pub fn validate(&self, bytes: &[u8]) -> Result<(), IrError> {
        let maximum = match self.dimension {
            TextureDimension::D2 => 8192,
            TextureDimension::D3 => 256,
        };
        if self.width == 0
            || self.height == 0
            || self.depth == 0
            || self.width > maximum
            || self.height > maximum
            || self.depth > maximum
            || (self.dimension == TextureDimension::D2 && self.depth != 1)
        {
            return Err(IrError::InvalidResource(
                "invalid packed texture extent".to_owned(),
            ));
        }
        let texel = match self.format {
            TexturePixelFormat::Rgba8Unorm => 4_u64,
            TexturePixelFormat::Rgba16Float => 8,
        };
        let size = u64::from(self.width) * u64::from(self.height) * u64::from(self.depth) * texel;
        if size > 256 * 1024 * 1024 {
            return Err(IrError::InvalidResource(
                "packed texture budget exceeded".to_owned(),
            ));
        }
        if bytes.len() as u64 != size {
            return Err(IrError::ElementCountMismatch);
        }
        Ok(())
    }
}
