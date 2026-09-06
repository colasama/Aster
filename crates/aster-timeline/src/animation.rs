use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Time;

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Interpolation {
    Linear,
    Step,
    Bezier(CubicBezier),
}

impl Interpolation {
    pub fn sample(self, progress: f64) -> f64 {
        match self {
            Self::Linear => progress,
            Self::Step => 0.0,
            Self::Bezier(curve) => curve.sample(progress),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct CubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl CubicBezier {
    pub const EASE: Self = Self {
        x1: 0.25,
        y1: 0.1,
        x2: 0.25,
        y2: 1.0,
    };

    pub const EASE_IN_OUT: Self = Self {
        x1: 0.42,
        y1: 0.0,
        x2: 0.58,
        y2: 1.0,
    };

    pub fn sample(self, progress: f64) -> f64 {
        let target = progress.clamp(0.0, 1.0);
        let mut parameter = target;
        for _ in 0..6 {
            let error = Self::cubic(parameter, self.x1, self.x2) - target;
            let slope = Self::derivative(parameter, self.x1, self.x2);
            if slope.abs() < 1e-7 {
                break;
            }
            parameter = (parameter - error / slope).clamp(0.0, 1.0);
        }
        Self::cubic(parameter, self.y1, self.y2)
    }

    fn cubic(t: f64, control1: f64, control2: f64) -> f64 {
        let inverse = 1.0 - t;
        3.0 * inverse * inverse * t * control1 + 3.0 * inverse * t * t * control2 + t * t * t
    }

    fn derivative(t: f64, control1: f64, control2: f64) -> f64 {
        3.0 * (1.0 - t).powi(2) * control1
            + 6.0 * (1.0 - t) * t * (control2 - control1)
            + 3.0 * t.powi(2) * (1.0 - control2)
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Keyframe {
    pub time: Time,
    pub value: f64,
    pub interpolation: Interpolation,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Animatable {
    Static { value: f64 },
    Animated { keyframes: Vec<Keyframe> },
}

impl Animatable {
    pub const fn constant(value: f64) -> Self {
        Self::Static { value }
    }

    pub fn evaluate(&self, time: Time) -> f64 {
        let keyframes = match self {
            Self::Static { value } => return *value,
            Self::Animated { keyframes } => keyframes,
        };
        if keyframes.is_empty() {
            return 0.0;
        }
        let next_index = keyframes.partition_point(|keyframe| keyframe.time <= time);
        if next_index == 0 {
            return keyframes[0].value;
        }
        if next_index == keyframes.len() {
            return keyframes[next_index - 1].value;
        }
        let previous = &keyframes[next_index - 1];
        let next = &keyframes[next_index];
        let span = next.time.seconds() - previous.time.seconds();
        if span <= f64::EPSILON {
            return next.value;
        }
        let progress = ((time.seconds() - previous.time.seconds()) / span).clamp(0.0, 1.0);
        let eased = previous.interpolation.sample(progress);
        previous.value + (next.value - previous.value) * eased
    }

    pub fn insert(&mut self, keyframe: Keyframe) {
        let Self::Animated { keyframes } = self else {
            let value = self.evaluate(keyframe.time);
            *self = Self::Animated {
                keyframes: vec![Keyframe { value, ..keyframe }],
            };
            return;
        };
        match keyframes.binary_search_by_key(&keyframe.time, |entry| entry.time) {
            Ok(index) => keyframes[index] = keyframe,
            Err(index) => keyframes.insert(index, keyframe),
        }
    }
}

impl Default for Animatable {
    fn default() -> Self {
        Self::constant(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_linear_keyframes_at_arbitrary_time() -> Result<(), crate::TimeError> {
        let animation = Animatable::Animated {
            keyframes: vec![
                Keyframe {
                    time: Time::ZERO,
                    value: 10.0,
                    interpolation: Interpolation::Linear,
                },
                Keyframe {
                    time: Time::new(1, 1)?,
                    value: 30.0,
                    interpolation: Interpolation::Linear,
                },
            ],
        };
        assert_eq!(animation.evaluate(Time::new(1, 2)?), 20.0);
        Ok(())
    }

    #[test]
    fn step_holds_previous_value() -> Result<(), crate::TimeError> {
        let animation = Animatable::Animated {
            keyframes: vec![
                Keyframe {
                    time: Time::ZERO,
                    value: 2.0,
                    interpolation: Interpolation::Step,
                },
                Keyframe {
                    time: Time::new(1, 1)?,
                    value: 4.0,
                    interpolation: Interpolation::Linear,
                },
            ],
        };
        assert_eq!(animation.evaluate(Time::new(3, 4)?), 2.0);
        Ok(())
    }
}
