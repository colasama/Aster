//! Lossless persisted editor records, separate from the legacy native command model.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

mod animation;
mod cloner;
mod media;
mod presence;
mod scene;
mod shape;
mod shape_graph;
mod text;
mod text_animation;
pub use animation::{Animatable, Keyframe, Transform};
pub use cloner::{Cloner, ClonerDistribution, ClonerEffector, ClonerEffectorKind};
pub use media::{
    AudioLayerSettings, AudioStreamMetadata, ProjectFont, Source, SourceInterpretation,
};
pub use presence::Field;
pub use scene::{
    Camera, Environment, EnvironmentSource, Generator, GeneratorParameter, Light, Marker, Material,
    MaterialTexture, MaterialTextures, Mesh, MotionBlur,
};
pub use shape::{BezierPath, BezierVertex, EffectMask, Lut3d, Shape, ShapeMorph, ShapeTrim, Solid};
pub use shape_graph::{ShapeChild, ShapeGraph, ShapeGroup, ShapeGroupTransform, ShapePathResource};
pub use text::TextStyle;
pub use text_animation::{
    TextAnimator, TextAnimatorGroup, TextAnimatorProperties, TextSelector, TextSelectorCommon,
};

/// Unknown and not-yet-interpreted fields remain intact across native persistence.
pub type Extensions = BTreeMap<String, Value>;

/// Storage numbers retain their JSON representation until an evaluator selects its precision.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub active_composition_id: String,
    pub compositions: Vec<Composition>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub sources: Field<Vec<Source>>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub fonts: Field<Vec<ProjectFont>>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

impl Project {
    pub fn composition(&self, id: &str) -> Option<&Composition> {
        self.compositions
            .iter()
            .find(|composition| composition.id == id)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Composition {
    pub id: String,
    pub name: String,
    pub width: Number,
    pub height: Number,
    pub frame_rate: FrameRate,
    pub duration: Number,
    pub work_area: WorkArea,
    pub background: [Number; 4],
    pub layers: Vec<Layer>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub motion_blur: Field<MotionBlur>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub environment: Field<Environment>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub markers: Field<Vec<Marker>>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrameRate {
    pub numerator: Number,
    pub denominator: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkArea {
    pub start: Number,
    pub end: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub visible: bool,
    pub solo: bool,
    pub locked: bool,
    pub three_dimensional: bool,
    pub in_point: Number,
    pub out_point: Number,
    pub blend_mode: String,
    pub color: [Number; 4],
    pub size: [Number; 2],
    pub transform: Transform,
    pub effects: Vec<Effect>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub parent_id: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub motion_blur: Field<bool>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub audio_enabled: Field<bool>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub audio: Field<AudioLayerSettings>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub time_offset: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub time_stretch: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub time_remap: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub text: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub source_id: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub source_composition_id: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub expressions: Field<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub material: Field<Material>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub light: Field<Light>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub camera: Field<Camera>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub mesh: Field<Mesh>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub generator: Field<Generator>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub cloner: Field<Cloner>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub shape: Field<Shape>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub shape_graph: Field<ShapeGraph>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub text_style: Field<TextStyle>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub text_animator: Field<TextAnimator>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub solid: Field<Solid>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    #[serde(rename = "type")]
    pub effect_type: String,
    pub name: String,
    pub enabled: bool,
    pub parameters: BTreeMap<String, Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub parameter_keyframes: Field<BTreeMap<String, Vec<Keyframe>>>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub parameter_expressions: Field<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub resource: Field<Lut3d>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub mask: Field<EffectMask>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[cfg(test)]
mod tests;
