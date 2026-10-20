use super::{Extensions, Field, FrameRate};
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub content_identity: String,
    pub interpretation: SourceInterpretation,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub data_url: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub relative_path: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub runtime_url: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub width: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub height: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub duration: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub audio: Field<AudioStreamMetadata>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub channels: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub sample_rate: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub stream_index: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub pattern: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub start_frame: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub end_frame: Field<Number>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub layer_count: Field<Number>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInterpretation {
    pub alpha: String,
    pub color_space: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub frame_rate: Field<FrameRate>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamMetadata {
    pub stream_index: Number,
    pub channels: Number,
    pub sample_rate: Number,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLayerSettings {
    pub levels_db: [Number; 2],
    pub pan: Number,
    pub muted: bool,
    pub reversed: bool,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFont {
    pub id: String,
    pub name: String,
    pub family: String,
    pub weight: Number,
    pub data_url: String,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub weight_range: Field<[Number; 2]>,
    #[serde(flatten)]
    pub extensions: Extensions,
}
