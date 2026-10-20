use super::{TextAnimatorTrack, TextBaseStyle, TextCharacter, TextUnitContext};
use crate::{EvaluationError, vertex::VertexPaint};
use aster_types::editor::Layer;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayoutUnit {
    #[serde(flatten)]
    pub context: TextUnitContext,
    pub code_point: f64,
    pub text: String,
    pub source_start: usize,
    pub source_end: usize,
}

impl TextAnimatorTrack {
    pub fn pixel_travel(
        &self,
        layer: &Layer,
        units: &[TextLayoutUnit],
        interval: [f64; 2],
        resolution_scale: f64,
    ) -> Result<f64, EvaluationError> {
        if units.len() > self.unit_limit {
            return Err(EvaluationError::InvalidScene(
                "text layout budget exceeded".into(),
            ));
        }
        if layer.kind != "text" || !layer.text_animator.value().is_some_and(|s| s.enabled) {
            return Ok(0.0);
        }
        let scale = Self::raster_scale(resolution_scale);
        let style = layer.text_style.value();
        let font_size = style
            .and_then(|s| s.font_size.as_f64())
            .unwrap_or(
                layer.size[1]
                    .as_f64()
                    .ok_or_else(|| EvaluationError::InvalidScene("text height".into()))?
                    * 0.56,
            )
            .max(1.0)
            * scale;
        let base = TextBaseStyle {
            fill_color: Some(VertexPaint::numbers(&layer.color)?),
            stroke_color: style
                .map(|s| VertexPaint::numbers(&s.stroke_color))
                .transpose()?,
            stroke_width: style.and_then(|s| s.stroke_width.as_f64()),
            ..TextBaseStyle::default()
        };
        let open = self.evaluate(interval[0])?;
        let close = self.evaluate(interval[1])?;
        let mut maximum: f64 = 0.0;
        for unit in units {
            let base = TextBaseStyle {
                code_point: Some(unit.code_point),
                ..base.clone()
            };
            let a = open.character(&unit.context, &base, true)?;
            let b = close.character(&unit.context, &base, true)?;
            maximum = maximum.max(a.travel_to(&b, unit.context.character_index, font_size, scale));
        }
        Ok(maximum)
    }

    pub fn raster_scale(value: f64) -> f64 {
        let bounded = if value.is_finite() {
            value.clamp(1.0, 8.0)
        } else {
            1.0
        };
        1.25f64.powf((bounded.ln() / 1.25f64.ln()).ceil()).min(8.0)
    }
}

impl TextCharacter {
    fn travel_to(&self, other: &Self, character_index: u32, font_size: f64, scale: f64) -> f64 {
        let radius = font_size * 0.75;
        let position = Self::distance(self.position, other.position) * scale;
        let anchor = Self::distance(self.anchor_point, other.anchor_point) * scale;
        let size = Self::distance(self.scale, other.scale) * radius;
        let rotation = self
            .rotation
            .iter()
            .zip(other.rotation)
            .fold(0.0f64, |distance, (a, b)| {
                distance.hypot(((b - a) * std::f64::consts::PI / 180.0).abs())
            })
            * radius;
        let skew = ((other.skew * std::f64::consts::PI / 180.0).tan()
            - (self.skew * std::f64::consts::PI / 180.0).tan())
        .abs()
            * radius
            + ((other.skew_axis - self.skew_axis) * std::f64::consts::PI / 180.0).abs() * radius;
        let index = f64::from(character_index) + 1.0;
        let tracking = (other.tracking - self.tracking).abs() * index * scale;
        let line_anchor = self.tracking.abs().max(other.tracking.abs())
            * index
            * ((other.line_anchor - self.line_anchor).abs() / 100.0)
            * scale;
        position
            + anchor
            + size
            + rotation
            + skew
            + tracking
            + line_anchor
            + Self::distance(self.line_spacing, other.line_spacing) * scale
            + Self::distance(self.blur, other.blur) * scale
            + if self.code_point == other.code_point {
                0.0
            } else {
                radius
            }
    }

    fn distance<const N: usize>(a: [f64; N], b: [f64; N]) -> f64 {
        a.into_iter()
            .zip(b)
            .fold(0.0f64, |distance, (a, b)| distance.hypot(b - a))
    }
}
