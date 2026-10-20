use super::{Animatable, Extensions, Field};
use serde::{Deserialize, Serialize};
use serde_json::Number;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub metallic: Number,
    pub roughness: Number,
    pub emissive: Number,
    pub alpha_mode: String,
    pub alpha_cutoff: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Light {
    pub kind: String,
    pub intensity: Number,
    pub range: Number,
    pub cone_angle: Number,
    pub shadow_quality: String,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    pub mode: String,
    pub projection: String,
    pub zoom: Animatable,
    pub film_size: Animatable,
    pub orthographic_size: Animatable,
    pub point_of_interest: [Animatable; 3],
    pub orientation: [Animatable; 3],
    pub depth_of_field: bool,
    pub focus_distance: Animatable,
    pub lock_focus_to_zoom: bool,
    pub aperture: Animatable,
    pub blur_level: Animatable,
    pub focus_area_width: Animatable,
    pub near_blur_level: Animatable,
    pub far_blur_level: Animatable,
    pub iris_shape: String,
    pub iris_rotation: Animatable,
    pub iris_roundness: Animatable,
    pub iris_aspect_ratio: Animatable,
    pub iris_diffraction_fringe: Animatable,
    pub highlight_gain: Animatable,
    pub highlight_threshold: Animatable,
    pub highlight_saturation: Animatable,
    pub render_quality: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mesh {
    pub name: String,
    pub positions: Vec<Number>,
    pub normals: Vec<Number>,
    pub uvs: Vec<Number>,
    pub indices: Vec<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub tangents: Field<Vec<Number>>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub source_material: Field<Material>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub base_color: Field<[Number; 4]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub material_textures: Field<MaterialTextures>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTexture {
    pub mime_type: String,
    pub data_url: String,
    pub tex_coord: Number,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub scale: Field<Number>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTextures {
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub base_color: Field<MaterialTexture>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub metallic_roughness: Field<MaterialTexture>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub normal: Field<MaterialTexture>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub emissive: Field<MaterialTexture>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generator {
    pub plugin_id: String,
    pub node_type: String,
    pub api_version: Number,
    pub parameters: BTreeMap<String, GeneratorParameter>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionBlur {
    pub enabled: bool,
    pub shutter_angle: Number,
    pub shutter_phase: Number,
    pub samples_per_frame: Number,
    pub adaptive_sample_limit: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub enabled: bool,
    pub intensity: Number,
    pub rotation: Number,
    pub source: EnvironmentSource,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSource {
    pub name: String,
    pub mime_type: String,
    pub data_url: String,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub time: Number,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub label: Field<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum GeneratorParameter {
    Number(Number),
    Text(String),
    Boolean(bool),
    Numbers(Vec<Number>),
}
