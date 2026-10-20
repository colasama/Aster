use super::SceneProject;
use crate::{EvaluationError, EvaluationLimits, ScalarTrack};
use aster_types::editor::Layer;

#[derive(Clone, Debug)]
pub struct LayerClock {
    pub(super) in_point: f64,
    offset: f64,
    stretch: f64,
    remap: Option<ScalarTrack>,
}

impl LayerClock {
    pub fn compile(layer: &Layer, limits: &EvaluationLimits) -> Result<Self, EvaluationError> {
        Ok(Self {
            in_point: SceneProject::number(&layer.in_point)?,
            offset: match layer.time_offset.value() {
                Some(value) => SceneProject::number(value)?,
                None => 0.0,
            },
            stretch: match layer.time_stretch.value() {
                Some(value) => SceneProject::number(value)?.max(0.01),
                None => 1.0,
            },
            remap: layer
                .time_remap
                .value()
                .map(|property| ScalarTrack::compile(property, limits))
                .transpose()?,
        })
    }

    pub fn evaluate(&self, time: f64, duration: f64) -> Result<f64, EvaluationError> {
        if !time.is_finite() || duration.is_nan() {
            return Err(EvaluationError::InvalidTime);
        }
        let value = match &self.remap {
            Some(remap) => remap.evaluate(time)?,
            None => self.offset + (time - self.in_point).max(0.0) / self.stretch,
        };
        Ok(duration.max(0.0).min(value.max(0.0)))
    }
}
