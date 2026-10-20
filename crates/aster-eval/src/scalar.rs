use std::collections::BTreeSet;

use aster_types::editor::{Animatable, Field};
use serde_json::Number;

use crate::{
    EvaluationError, EvaluationLimits,
    curve::{CubicBezier, TemporalSample},
};

#[derive(Clone, Debug)]
pub struct ScalarTrack {
    storage: TrackStorage,
}

#[derive(Clone, Debug)]
enum TrackStorage {
    Static(f64),
    Animated(Vec<CompiledKey>),
}

#[derive(Clone, Copy, Debug)]
enum Interpolation {
    Linear,
    Step,
    Bezier(CubicBezier),
}

#[derive(Clone, Debug)]
struct CompiledKey {
    time: f64,
    value: f64,
    interpolation: Interpolation,
    spatial_in: Option<f64>,
    spatial_out: Option<f64>,
}

impl ScalarTrack {
    pub fn compile(
        property: &Animatable,
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        Self::compile_with_metadata_rules(property, limits, true)
    }

    pub(crate) fn compile_shape_graph(
        property: &Animatable,
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        Self::compile_with_metadata_rules(property, limits, false)
    }

    fn compile_with_metadata_rules(
        property: &Animatable,
        limits: &EvaluationLimits,
        editor_key_identity: bool,
    ) -> Result<Self, EvaluationError> {
        let storage = match property {
            Animatable::Static { value, .. } => TrackStorage::Static(Self::number(value, "value")?),
            Animatable::Animated { keyframes, .. } => {
                if keyframes.len() > limits.max_keyframes.min(10_000) {
                    return Err(EvaluationError::InvalidProperty(
                        "keyframe budget exceeded".into(),
                    ));
                }
                let mut ids = BTreeSet::new();
                let mut compiled = Vec::with_capacity(keyframes.len());
                let mut previous = f64::NEG_INFINITY;
                for key in keyframes {
                    let time = Self::number(&key.time, "key time")?;
                    if time <= previous
                        || key.id.is_empty()
                        || (editor_key_identity && (time < 0.0 || !ids.insert(&key.id)))
                    {
                        return Err(EvaluationError::InvalidProperty(
                            "keyframes need unique IDs and strictly increasing nonnegative times"
                                .into(),
                        ));
                    }
                    previous = time;
                    let mut controls = [0.42, 0.0, 0.58, 1.0];
                    match &key.easing {
                        Field::Absent => {}
                        Field::Null => {
                            return Err(EvaluationError::InvalidProperty("null easing".into()));
                        }
                        Field::Value(values) => {
                            for (target, value) in controls.iter_mut().zip(values) {
                                *target = Self::number(value, "easing control")?;
                            }
                        }
                    }
                    let interpolation = match key.interpolation.as_str() {
                        "linear" => Interpolation::Linear,
                        "step" => Interpolation::Step,
                        "bezier" => Interpolation::Bezier(CubicBezier { controls }),
                        _ => {
                            return Err(EvaluationError::InvalidProperty(
                                "unknown interpolation".into(),
                            ));
                        }
                    };
                    compiled.push(CompiledKey {
                        time,
                        value: Self::number(&key.value, "key value")?,
                        interpolation,
                        spatial_in: Self::optional_number(&key.spatial_in, "incoming tangent")?,
                        spatial_out: Self::optional_number(&key.spatial_out, "outgoing tangent")?,
                    });
                }
                TrackStorage::Animated(compiled)
            }
        };
        Ok(Self { storage })
    }

    fn number(value: &Number, field: &str) -> Result<f64, EvaluationError> {
        value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| EvaluationError::InvalidProperty(format!("{field} must be finite")))
    }

    fn optional_number(value: &Field<Number>, field: &str) -> Result<Option<f64>, EvaluationError> {
        match value {
            Field::Absent => Ok(None),
            Field::Null => Err(EvaluationError::InvalidProperty(format!(
                "{field} cannot be null"
            ))),
            Field::Value(value) => Ok(Some(Self::number(value, field)?)),
        }
    }

    pub fn evaluate(&self, time: f64) -> Result<f64, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let keys = match &self.storage {
            TrackStorage::Static(value) => return Ok(*value),
            TrackStorage::Animated(keys) => keys,
        };
        if keys.is_empty() {
            return Ok(0.0);
        }
        let next_index = keys.partition_point(|key| key.time <= time);
        if next_index == 0 {
            return Ok(keys[0].value);
        }
        if next_index == keys.len() {
            return Ok(keys[keys.len() - 1].value);
        }
        let previous = &keys[next_index - 1];
        let next = &keys[next_index];
        let span = next.time - previous.time;
        if span <= f64::EPSILON {
            return Ok(next.value);
        }
        let progress = ((time - previous.time) / span).clamp(0.0, 1.0);
        let eased = previous.sample(progress).value;
        Ok(
            if let Some([start, outgoing, incoming, end]) = previous.spatial_controls(next) {
                CubicBezier::spatial_value(eased, start, outgoing, incoming, end)
            } else {
                previous.value + (next.value - previous.value) * eased
            },
        )
    }

    pub fn speed(&self, time: f64) -> Result<f64, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let TrackStorage::Animated(keys) = &self.storage else {
            return Ok(0.0);
        };
        if keys.len() < 2 {
            return Ok(0.0);
        }
        let next_index = keys.partition_point(|key| key.time <= time);
        if next_index == 0 {
            return Ok(0.0);
        }
        let end = if next_index == keys.len() {
            if time > keys[keys.len() - 1].time {
                return Ok(0.0);
            }
            keys.len() - 1
        } else {
            next_index
        };
        let previous = &keys[end - 1];
        let next = &keys[end];
        let span = next.time - previous.time;
        if span <= f64::EPSILON || matches!(previous.interpolation, Interpolation::Step) {
            return Ok(0.0);
        }
        let temporal = previous.sample(((time - previous.time) / span).clamp(0.0, 1.0));
        let value_slope =
            if let Some([start, outgoing, incoming, end]) = previous.spatial_controls(next) {
                CubicBezier::spatial_derivative(temporal.value, start, outgoing, incoming, end)
            } else {
                next.value - previous.value
            };
        let speed = value_slope * temporal.slope / span;
        Ok(if speed.is_finite() { speed } else { 0.0 })
    }
}

impl CompiledKey {
    fn spatial_controls(&self, next: &Self) -> Option<[f64; 4]> {
        let (outgoing, incoming) = match (self.spatial_out, next.spatial_in) {
            (None, None) => return None,
            (Some(outgoing), None) => (outgoing, 0.0),
            (None, Some(incoming)) => (0.0, incoming),
            (Some(outgoing), Some(incoming)) => (outgoing, incoming),
        };
        Some([
            self.value,
            self.value + outgoing,
            next.value + incoming,
            next.value,
        ])
    }

    fn sample(&self, progress: f64) -> TemporalSample {
        match self.interpolation {
            Interpolation::Linear => TemporalSample {
                value: progress,
                slope: 1.0,
            },
            Interpolation::Step => TemporalSample {
                value: 0.0,
                slope: 0.0,
            },
            Interpolation::Bezier(curve) => curve.sample(progress),
        }
    }
}
