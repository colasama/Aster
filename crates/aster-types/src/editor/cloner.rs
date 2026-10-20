use super::Extensions;
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Cloner {
    pub distribution: ClonerDistribution,
    pub effectors: Vec<ClonerEffector>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClonerDistribution {
    Grid {
        count: [Number; 3],
        spacing: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
    Radial {
        count: Number,
        radius: Number,
        #[serde(rename = "startAngle")]
        start_angle: Number,
        #[serde(rename = "endAngle")]
        end_angle: Number,
        axis: String,
        #[serde(rename = "alignRotation")]
        align_rotation: bool,
        #[serde(flatten)]
        extensions: Extensions,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ClonerEffector {
    pub id: String,
    pub enabled: bool,
    pub strength: Number,
    #[serde(flatten)]
    pub kind: ClonerEffectorKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClonerEffectorKind {
    Position {
        value: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
    Scale {
        value: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
    Rotation {
        value: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
    Random {
        seed: Number,
        position: [Number; 3],
        scale: [Number; 3],
        rotation: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
    Audio {
        band: [Number; 2],
        gain: Number,
        position: [Number; 3],
        scale: [Number; 3],
        rotation: [Number; 3],
        #[serde(flatten)]
        extensions: Extensions,
    },
}
