use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{BlobDescriptor, ElementType, IrError};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CameraPoseMode {
    OneNode,
    TwoNode,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CameraProjectionKind {
    Perspective,
    Orthographic,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CameraIrisShape {
    FastRectangle,
    Square,
    Triangle,
    Pentagon,
    Hexagon,
    Heptagon,
    Octagon,
    Nonagon,
    Decagon,
    Circle,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CameraParametersSlice {
    pub blob_index: u32,
    pub pose_mode: CameraPoseMode,
    pub projection_kind: CameraProjectionKind,
    pub optics_projection: CameraProjectionKind,
    pub depth_of_field: bool,
    pub lock_focus_to_zoom: bool,
    pub iris_shape: CameraIrisShape,
}

impl CameraParametersSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        // Four pose vec3s, four projection scalars, and 21 optics scalars as little-endian f64.
        if blob.element_type != ElementType::U8 || blob.byte_length != 296 {
            return Err(IrError::ElementCountMismatch);
        }
        Ok(())
    }
}
