use super::TextTrack;
use crate::{EvaluationError, EvaluationLimits, ScalarTrack};
use aster_types::editor::{Animatable, Field, TextAnimatorProperties};

#[derive(Clone, Debug)]
pub(super) struct PropertyTracks {
    anchor_point: Option<[ScalarTrack; 3]>,
    position: Option<[ScalarTrack; 3]>,
    scale: Option<[ScalarTrack; 3]>,
    rotation: Option<[ScalarTrack; 3]>,
    fill_color: Option<[ScalarTrack; 4]>,
    stroke_color: Option<[ScalarTrack; 4]>,
    line_spacing: Option<[ScalarTrack; 2]>,
    blur: Option<[ScalarTrack; 2]>,
    skew: Option<ScalarTrack>,
    skew_axis: Option<ScalarTrack>,
    opacity: Option<ScalarTrack>,
    stroke_width: Option<ScalarTrack>,
    tracking: Option<ScalarTrack>,
    line_anchor: Option<ScalarTrack>,
    character_offset: Option<ScalarTrack>,
    character_value: Option<ScalarTrack>,
    full_unicode: bool,
}
#[derive(Clone, Debug)]
pub(super) struct PropertyFrame {
    pub anchor_point: Option<[f64; 3]>,
    pub position: Option<[f64; 3]>,
    pub scale: Option<[f64; 3]>,
    pub rotation: Option<[f64; 3]>,
    pub fill_color: Option<[f64; 4]>,
    pub stroke_color: Option<[f64; 4]>,
    pub line_spacing: Option<[f64; 2]>,
    pub blur: Option<[f64; 2]>,
    pub skew: Option<f64>,
    pub skew_axis: Option<f64>,
    pub opacity: Option<f64>,
    pub stroke_width: Option<f64>,
    pub tracking: Option<f64>,
    pub line_anchor: Option<f64>,
    pub character_offset: Option<f64>,
    pub character_value: Option<f64>,
    pub full_unicode: bool,
}
impl PropertyTracks {
    pub fn compile(
        source: &TextAnimatorProperties,
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        let replacement =
            source.character_offset.value().is_some() || source.character_value.value().is_some();
        let range = source.character_range.value().map(String::as_str);
        if (replacement && !matches!(range, Some("preserveCaseAndDigits" | "fullUnicode")))
            || (!replacement && range.is_some())
        {
            return Err(EvaluationError::InvalidProperty(
                "invalid text character range".into(),
            ));
        }
        Ok(Self {
            anchor_point: Self::vector(&source.anchor_point, [-8192.0, 8192.0], limits)?,
            position: Self::vector(&source.position, [-8192.0, 8192.0], limits)?,
            scale: Self::vector(&source.scale, [-10000.0, 10000.0], limits)?,
            rotation: Self::vector(&source.rotation, [-36000.0, 36000.0], limits)?,
            fill_color: Self::vector(&source.fill_color, [0.0, 1.0], limits)?,
            stroke_color: Self::vector(&source.stroke_color, [0.0, 1.0], limits)?,
            line_spacing: Self::vector(&source.line_spacing, [-8192.0, 8192.0], limits)?,
            blur: Self::vector(&source.blur, [0.0, 4096.0], limits)?,
            skew: source
                .skew
                .value()
                .map(|p| TextTrack::compile(p, [-360.0, 360.0], limits))
                .transpose()?,
            skew_axis: source
                .skew_axis
                .value()
                .map(|p| TextTrack::compile(p, [-360.0, 360.0], limits))
                .transpose()?,
            opacity: source
                .opacity
                .value()
                .map(|p| TextTrack::compile(p, [0.0, 100.0], limits))
                .transpose()?,
            stroke_width: source
                .stroke_width
                .value()
                .map(|p| TextTrack::compile(p, [-4096.0, 4096.0], limits))
                .transpose()?,
            tracking: source
                .tracking
                .value()
                .map(|p| TextTrack::compile(p, [-10000.0, 10000.0], limits))
                .transpose()?,
            line_anchor: source
                .line_anchor
                .value()
                .map(|p| TextTrack::compile(p, [0.0, 100.0], limits))
                .transpose()?,
            character_offset: source
                .character_offset
                .value()
                .map(|p| TextTrack::compile(p, [-1114111.0, 1114111.0], limits))
                .transpose()?,
            character_value: source
                .character_value
                .value()
                .map(|p| TextTrack::compile(p, [0.0, 1114111.0], limits))
                .transpose()?,
            full_unicode: range == Some("fullUnicode"),
        })
    }
    fn vector<const N: usize>(
        source: &Field<[Animatable; N]>,
        bounds: [f64; 2],
        limits: &EvaluationLimits,
    ) -> Result<Option<[ScalarTrack; N]>, EvaluationError> {
        source
            .value()
            .map(|values| {
                values
                    .iter()
                    .map(|p| TextTrack::compile(p, bounds, limits))
                    .collect::<Result<Vec<_>, _>>()?
                    .try_into()
                    .map_err(|_| EvaluationError::InvalidProperty("text vector dimension".into()))
            })
            .transpose()
    }
    pub fn evaluate(&self, time: f64) -> Result<PropertyFrame, EvaluationError> {
        Ok(PropertyFrame {
            anchor_point: Self::values(&self.anchor_point, time)?,
            position: Self::values(&self.position, time)?,
            scale: Self::values(&self.scale, time)?,
            rotation: Self::values(&self.rotation, time)?,
            fill_color: Self::values(&self.fill_color, time)?,
            stroke_color: Self::values(&self.stroke_color, time)?,
            line_spacing: Self::values(&self.line_spacing, time)?,
            blur: Self::values(&self.blur, time)?,
            skew: self
                .skew
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            skew_axis: self
                .skew_axis
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            opacity: self
                .opacity
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            stroke_width: self
                .stroke_width
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            tracking: self
                .tracking
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            line_anchor: self
                .line_anchor
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            character_offset: self
                .character_offset
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            character_value: self
                .character_value
                .as_ref()
                .map(|p| p.evaluate(time))
                .transpose()?
                .map(|v| if v.is_finite() { v } else { 0.0 }),
            full_unicode: self.full_unicode,
        })
    }
    fn values<const N: usize>(
        tracks: &Option<[ScalarTrack; N]>,
        time: f64,
    ) -> Result<Option<[f64; N]>, EvaluationError> {
        let Some(tracks) = tracks else {
            return Ok(None);
        };
        let mut values = [0.0; N];
        for (out, track) in values.iter_mut().zip(tracks) {
            let value = track.evaluate(time)?;
            *out = if value.is_finite() { value } else { 0.0 };
        }
        Ok(Some(values))
    }
    pub fn time_bounds(source: &TextAnimatorProperties, bounds: &mut [f64; 2]) {
        if let Some(tracks) = source.anchor_point.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.position.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.scale.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.rotation.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.fill_color.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.stroke_color.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.line_spacing.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(tracks) = source.blur.value() {
            for track in tracks {
                TextTrack::time_bounds(track, bounds);
            }
        }
        if let Some(track) = source.skew.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.skew_axis.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.opacity.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.stroke_width.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.tracking.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.line_anchor.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.character_offset.value() {
            TextTrack::time_bounds(track, bounds);
        }
        if let Some(track) = source.character_value.value() {
            TextTrack::time_bounds(track, bounds);
        }
    }
}
