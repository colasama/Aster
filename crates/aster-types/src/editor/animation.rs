use serde::{Deserialize, Serialize};
use serde_json::Number;

use super::{Extensions, Field};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Transform {
    pub position: [Animatable; 3],
    pub rotation: [Animatable; 3],
    pub scale: [Animatable; 3],
    pub anchor: [Animatable; 3],
    pub opacity: Animatable,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Animatable {
    Static {
        value: Number,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Animated {
        keyframes: Vec<Keyframe>,
        #[serde(flatten)]
        extensions: Extensions,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub id: String,
    pub time: Number,
    pub value: Number,
    pub interpolation: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub easing: Field<[Number; 4]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub spatial_in: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub spatial_out: Field<Number>,
    #[serde(flatten)]
    pub extensions: Extensions,
}
