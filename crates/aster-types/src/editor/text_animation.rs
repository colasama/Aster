use super::{Animatable, Extensions, Field};
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TextAnimator {
    pub enabled: bool,
    pub groups: Vec<TextAnimatorGroup>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextAnimatorGroup {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub random_seed: Number,
    pub selectors: Vec<TextSelector>,
    pub properties: TextAnimatorProperties,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextAnimatorProperties {
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub anchor_point: Field<[Animatable; 3]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub position: Field<[Animatable; 3]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub scale: Field<[Animatable; 3]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub rotation: Field<[Animatable; 3]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub fill_color: Field<[Animatable; 4]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub stroke_color: Field<[Animatable; 4]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub line_spacing: Field<[Animatable; 2]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub blur: Field<[Animatable; 2]>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub skew: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub skew_axis: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub opacity: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub stroke_width: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub tracking: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub line_anchor: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub character_offset: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub character_value: Field<Animatable>,
    #[serde(default, skip_serializing_if = "Field::is_absent")]
    pub character_range: Field<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextSelectorCommon {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub mode: String,
    pub amount: Animatable,
    pub based_on: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TextSelector {
    Range {
        #[serde(flatten)]
        common: TextSelectorCommon,
        units: String,
        start: Animatable,
        end: Animatable,
        offset: Animatable,
        shape: String,
        smoothness: Animatable,
        ease_high: Animatable,
        ease_low: Animatable,
        randomize_order: bool,
        random_seed: Number,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Wiggly {
        #[serde(flatten)]
        common: TextSelectorCommon,
        minimum_amount: Animatable,
        maximum_amount: Animatable,
        wiggles_per_second: Animatable,
        correlation: Animatable,
        temporal_phase: Animatable,
        spatial_phase: Animatable,
        random_seed: Number,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Expression {
        #[serde(flatten)]
        common: TextSelectorCommon,
        expression: String,
        #[serde(default, skip_serializing_if = "Field::is_absent")]
        time_offset: Field<Animatable>,
        #[serde(flatten)]
        extensions: Extensions,
    },
}
