mod character;
mod collation;
pub use collation::TextCollation;
mod math;
mod properties;
mod selectors;
mod stack;
mod temporal;

use crate::{EvaluationError, EvaluationLimits, ScalarTrack};
use aster_types::editor::Animatable;
pub use character::{TextBaseStyle, TextCharacter};
pub use selectors::{TextSelectorFrame, TextSelectorTrack};
use serde::{Deserialize, Serialize};
pub use stack::{TextAnimatorFrame, TextAnimatorTrack};
pub use temporal::TextLayoutUnit;

#[derive(Clone, Debug, clap::Args)]
pub struct TextLimits {
    #[arg(long,default_value_t=Self::default().max_text_groups)]
    pub max_text_groups: usize,
    #[arg(long,default_value_t=Self::default().max_text_selectors)]
    pub max_text_selectors: usize,
    #[arg(long,default_value_t=Self::default().max_text_units)]
    pub max_text_units: usize,
}
impl Default for TextLimits {
    fn default() -> Self {
        Self {
            max_text_groups: 32,
            max_text_selectors: 32,
            max_text_units: 4096,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextUnitContext {
    pub character_index: u32,
    pub character_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_excluding_spaces_index: Option<u32>,
    pub character_excluding_spaces_count: u32,
    pub word_index: u32,
    pub word_count: u32,
    pub line_index: u32,
    pub line_count: u32,
    pub is_whitespace: bool,
}

pub(crate) struct TextTrack;
impl TextTrack {
    pub fn time_bounds(track: &Animatable, bounds: &mut [f64; 2]) {
        if let Animatable::Animated { keyframes, .. } = track
            && let (Some(first), Some(last)) = (keyframes.first(), keyframes.last())
        {
            bounds[0] = bounds[0].min(first.time.as_f64().unwrap_or(f64::INFINITY));
            bounds[1] = bounds[1].max(last.time.as_f64().unwrap_or(f64::NEG_INFINITY));
        }
    }
    pub fn compile(
        property: &Animatable,
        bounds: [f64; 2],
        limits: &EvaluationLimits,
    ) -> Result<ScalarTrack, EvaluationError> {
        let values: Vec<_> = match property {
            Animatable::Static { value, .. } => vec![value],
            Animatable::Animated { keyframes, .. } => keyframes.iter().map(|k| &k.value).collect(),
        };
        if values.iter().any(|n| {
            n.as_f64()
                .is_none_or(|n| !n.is_finite() || n < bounds[0] || n > bounds[1])
        }) {
            return Err(EvaluationError::InvalidProperty(
                "text property is outside its admitted range".into(),
            ));
        }
        ScalarTrack::compile(property, limits)
    }

    pub fn identifier(value: &str) -> Result<(), EvaluationError> {
        if value.is_empty() || value.encode_utf16().count() > 256 {
            return Err(EvaluationError::InvalidScene(
                "invalid text identity".into(),
            ));
        }
        Ok(())
    }

    pub fn seed(value: &serde_json::Number) -> Result<f64, EvaluationError> {
        value
            .as_f64()
            .filter(|v| v.fract() == 0.0 && (-2_147_483_648.0..=2_147_483_647.0).contains(v))
            .ok_or_else(|| EvaluationError::InvalidScene("invalid text random seed".into()))
    }
}
