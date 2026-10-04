use crate::{IrError, MediaFrameDescriptor, MediaSample, MediaTextureFormat, ResourceHash};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RasterOrigin {
    Text,
    Svg,
    Psd,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RasterSample {
    pub origin: RasterOrigin,
    /// x/y/width/height, each represented by two little-endian IEEE-754 f64 words.
    pub bounds_f64_le: [u32; 8],
}

impl RasterSample {
    pub fn bounds(&self) -> Result<[f64; 4], IrError> {
        let mut values = [0.0; 4];
        for (index, pair) in self.bounds_f64_le.chunks_exact(2).enumerate() {
            values[index] = f64::from_bits(u64::from(pair[0]) | (u64::from(pair[1]) << 32));
        }
        if values.iter().any(|value| !value.is_finite()) || values[2] <= 0.0 || values[3] <= 0.0 {
            return Err(IrError::InvalidResource("invalid raster bounds".to_owned()));
        }
        Ok(values)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RasterPixelsDescriptor {
    pub frame: ResourceHash,
    #[schemars(range(min = 1, max = 16384))]
    pub width: u32,
    #[schemars(range(min = 1, max = 16384))]
    pub height: u32,
    pub format: MediaTextureFormat,
}

impl RasterPixelsDescriptor {
    pub fn validate(&self, bytes: &[u8]) -> Result<(), IrError> {
        self.frame.validate()?;
        if self.width == 0 || self.height == 0 || self.width > 16384 || self.height > 16384 {
            return Err(IrError::InvalidResource("invalid raster extent".to_owned()));
        }
        if u64::from(self.width) * u64::from(self.height) * 4 != bytes.len() as u64 {
            return Err(IrError::ElementCountMismatch);
        }
        Ok(())
    }

    pub fn validate_frame(&self, frame: &MediaFrameDescriptor) -> Result<(), IrError> {
        if !matches!(frame.sample, MediaSample::Raster(_))
            || frame.width != self.width
            || frame.height != self.height
            || frame.format != self.format
        {
            return Err(IrError::ResourceConflict);
        }
        Ok(())
    }
}
