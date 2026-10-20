use super::{Extensions, Field};
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub font_family: String,
    pub font_size: Number,
    pub font_weight: Number,
    pub alignment: String,
    pub tracking: Number,
    pub leading: Number,
    pub stroke_width: Number,
    pub stroke_color: [Number; 4],
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub font_style: Field<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}
