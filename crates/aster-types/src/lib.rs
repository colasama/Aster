//! Shared project data and time-addressable property types.

use std::collections::BTreeMap;

use aster_timeline::{Animatable, FrameRate, Time};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Project {
    pub schema_version: u32,
    pub id: Uuid,
    pub name: String,
    pub active_composition: Uuid,
    pub compositions: Vec<Composition>,
}

impl Project {
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn composition(&self, id: Uuid) -> Option<&Composition> {
        self.compositions
            .iter()
            .find(|composition| composition.id == id)
    }

    pub fn composition_mut(&mut self, id: Uuid) -> Option<&mut Composition> {
        self.compositions
            .iter_mut()
            .find(|composition| composition.id == id)
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Composition {
    pub id: Uuid,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    pub duration: Time,
    pub background: [f32; 4],
    pub layers: Vec<Layer>,
}

impl Composition {
    pub fn layer(&self, id: Uuid) -> Option<&Layer> {
        self.layers.iter().find(|layer| layer.id == id)
    }

    pub fn layer_mut(&mut self, id: Uuid) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|layer| layer.id == id)
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Layer {
    pub id: Uuid,
    pub name: String,
    pub kind: LayerKind,
    pub parent: Option<Uuid>,
    pub visible: bool,
    pub solo: bool,
    pub locked: bool,
    pub in_point: Time,
    pub out_point: Time,
    pub blend_mode: BlendMode,
    pub transform: Transform,
    pub effects: Vec<Effect>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayerKind {
    Image {
        asset_id: Uuid,
    },
    Video {
        asset_id: Uuid,
    },
    Text {
        text: String,
    },
    Shape {
        shape: String,
    },
    Mesh {
        asset_id: Uuid,
    },
    Generator {
        plugin_id: String,
        node_type: String,
        api_version: u32,
        parameters: BTreeMap<String, GeneratorParameterValue>,
    },
    Camera {
        perspective: bool,
        focal_length: f32,
    },
    Light {
        light_type: String,
        intensity: f32,
    },
    Precomposition {
        composition_id: Uuid,
    },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(untagged)]
pub enum GeneratorParameterValue {
    Number(f64),
    Choice(String),
    Boolean(bool),
    Vector(Vec<f64>),
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    #[default]
    Normal,
    Add,
    Multiply,
    Screen,
    Overlay,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Transform {
    pub position_x: Animatable,
    pub position_y: Animatable,
    pub position_z: Animatable,
    pub rotation_x: Animatable,
    pub rotation_y: Animatable,
    pub rotation_z: Animatable,
    pub scale_x: Animatable,
    pub scale_y: Animatable,
    pub scale_z: Animatable,
    pub anchor_x: Animatable,
    pub anchor_y: Animatable,
    pub anchor_z: Animatable,
    pub opacity: Animatable,
}

impl Transform {
    pub fn evaluate(&self, time: Time) -> TransformSnapshot {
        TransformSnapshot {
            position: [
                self.position_x.evaluate(time),
                self.position_y.evaluate(time),
                self.position_z.evaluate(time),
            ],
            rotation: [
                self.rotation_x.evaluate(time),
                self.rotation_y.evaluate(time),
                self.rotation_z.evaluate(time),
            ],
            scale: [
                self.scale_x.evaluate(time),
                self.scale_y.evaluate(time),
                self.scale_z.evaluate(time),
            ],
            anchor: [
                self.anchor_x.evaluate(time),
                self.anchor_y.evaluate(time),
                self.anchor_z.evaluate(time),
            ],
            opacity: self.opacity.evaluate(time).clamp(0.0, 1.0),
        }
    }
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            position_x: Animatable::constant(0.0),
            position_y: Animatable::constant(0.0),
            position_z: Animatable::constant(0.0),
            rotation_x: Animatable::constant(0.0),
            rotation_y: Animatable::constant(0.0),
            rotation_z: Animatable::constant(0.0),
            scale_x: Animatable::constant(1.0),
            scale_y: Animatable::constant(1.0),
            scale_z: Animatable::constant(1.0),
            anchor_x: Animatable::constant(0.0),
            anchor_y: Animatable::constant(0.0),
            anchor_z: Animatable::constant(0.0),
            opacity: Animatable::constant(1.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransformSnapshot {
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub scale: [f64; 3],
    pub anchor: [f64; 3],
    pub opacity: f64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Effect {
    pub id: Uuid,
    pub plugin_id: String,
    pub name: String,
    pub enabled: bool,
    pub parameters: BTreeMap<String, f64>,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyKey {
    PositionX,
    PositionY,
    PositionZ,
    RotationX,
    RotationY,
    RotationZ,
    ScaleX,
    ScaleY,
    ScaleZ,
    AnchorX,
    AnchorY,
    AnchorZ,
    Opacity,
}

impl Transform {
    pub fn property_mut(&mut self, property: PropertyKey) -> &mut Animatable {
        match property {
            PropertyKey::PositionX => &mut self.position_x,
            PropertyKey::PositionY => &mut self.position_y,
            PropertyKey::PositionZ => &mut self.position_z,
            PropertyKey::RotationX => &mut self.rotation_x,
            PropertyKey::RotationY => &mut self.rotation_y,
            PropertyKey::RotationZ => &mut self.rotation_z,
            PropertyKey::ScaleX => &mut self.scale_x,
            PropertyKey::ScaleY => &mut self.scale_y,
            PropertyKey::ScaleZ => &mut self.scale_z,
            PropertyKey::AnchorX => &mut self.anchor_x,
            PropertyKey::AnchorY => &mut self.anchor_y,
            PropertyKey::AnchorZ => &mut self.anchor_z,
            PropertyKey::Opacity => &mut self.opacity,
        }
    }
}
