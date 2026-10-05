use crate::{BlobDescriptor, ElementType, IrError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinalOutputSlice {
    pub blob_index: u32,
    pub route: FinalOutputRoute,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FinalOutputRoute {
    Beauty { source: FinalBeautySource },
    Depth { mode: FinalDepthMode },
    Surface { mode: FinalSurfaceMode },
    Visualizer { mode: FinalVisualization },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FinalBeautySource {
    Scene,
    MotionBlur,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinalDepthMode {
    DepthFog,
    DepthOfField,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinalSurfaceMode {
    SelectionIsolation,
    VectorMotionBlur,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinalVisualization {
    LinearColor,
    Luminance,
    Alpha,
    Normal,
    ObjectId,
    MaterialId,
    WorldPosition,
    MotionVector,
}
impl FinalOutputSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        if blob.element_type != ElementType::F32Le
            || blob.element_count != 4
            || blob.byte_length != 16
        {
            return Err(IrError::InvalidHeader("output clear layout".to_owned()));
        }
        Ok(())
    }
    pub fn validate_bytes(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != 16 {
            return Err(IrError::InvalidHeader("output clear payload".to_owned()));
        }
        for chunk in bytes.chunks_exact(4) {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(IrError::InvalidHeader("output clear color".to_owned()));
            }
        }
        Ok(())
    }
}
