use crate::IrError;
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
