use super::{Animatable, BezierPath, Extensions, Field};
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapeGraph {
    pub id: String,
    pub revision: Number,
    pub paths: Vec<ShapePathResource>,
    pub groups: Vec<ShapeGroup>,
    pub root_group_ids: Vec<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ShapePathResource {
    pub id: String,
    pub revision: Number,
    pub path: BezierPath,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ShapeGroup {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub transform: ShapeGroupTransform,
    pub children: Vec<ShapeChild>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ShapeGroupTransform {
    pub position: [Animatable; 2],
    pub scale: [Animatable; 2],
    pub rotation: Animatable,
    pub opacity: Animatable,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShapeChild {
    Group {
        id: String,
        #[serde(rename = "groupId")]
        group_id: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Path {
        id: String,
        #[serde(rename = "pathId")]
        path_id: String,
        visible: bool,
        #[serde(default, skip_serializing_if = "Field::is_absent")]
        transform: Field<Box<ShapeGroupTransform>>,
        #[serde(flatten)]
        extensions: Extensions,
    },
}
