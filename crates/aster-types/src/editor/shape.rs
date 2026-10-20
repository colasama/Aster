use super::{Animatable, Extensions, Field};
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub kind: String,
    pub roundness: Number,
    pub stroke_width: Number,
    pub stroke_color: [Number; 4],
    pub fill_mode: String,
    pub gradient_color: [Number; 4],
    pub gradient_angle: Number,
    pub dash_length: Number,
    pub dash_gap: Number,
    pub line_cap: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub line_join: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub path: Field<BezierPath>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub morph: Field<ShapeMorph>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub trim: Field<ShapeTrim>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BezierPath {
    pub closed: bool,
    pub vertices: Vec<BezierVertex>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BezierVertex {
    pub position: [Number; 2],
    pub in_tangent: [Number; 2],
    pub out_tangent: [Number; 2],
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeMorph {
    pub target: BezierPath,
    pub progress: Animatable,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeTrim {
    pub start: Number,
    pub end: Number,
    pub offset: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Solid {
    pub width: Number,
    pub height: Number,
    pub color: [Number; 4],
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectMask {
    pub shape: String,
    pub center: [Number; 2],
    pub size: [Number; 2],
    pub feather: Number,
    pub opacity: Number,
    pub invert: bool,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub path_id: Field<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lut3d {
    pub kind: String,
    pub name: String,
    pub size: Number,
    pub data: Vec<Number>,
    pub domain_min: [Number; 3],
    pub domain_max: [Number; 3],
    pub checksum: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub title: Field<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}
