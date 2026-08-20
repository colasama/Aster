use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Interpolation, Time};

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct StringKeyframe {
    pub time: Time,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum StringAnimatable {
    Static { value: String },
    Animated { keyframes: Vec<StringKeyframe> },
}

impl StringAnimatable {
    pub fn constant(value: impl Into<String>) -> Self {
        Self::Static {
            value: value.into(),
        }
    }

    #[must_use]
    pub fn evaluate(&self, time: Time) -> &str {
        match self {
            Self::Static { value } => value,
            Self::Animated { keyframes } => {
                let next = keyframes.partition_point(|keyframe| keyframe.time <= time);
                if next == 0 {
                    keyframes.first().map_or("", |keyframe| &keyframe.value)
                } else {
                    &keyframes[next - 1].value
                }
            }
        }
    }

    pub fn insert(&mut self, keyframe: StringKeyframe) {
        let Self::Animated { keyframes } = self else {
            *self = Self::Animated {
                keyframes: vec![keyframe],
            };
            return;
        };
        match keyframes.binary_search_by_key(&keyframe.time, |entry| entry.time) {
            Ok(index) => keyframes[index] = keyframe,
            Err(index) => keyframes.insert(index, keyframe),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct Quaternion {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl Quaternion {
    pub const IDENTITY: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        w: 1.0,
    };

    #[must_use]
    pub fn normalized(self) -> Self {
        let length = (self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w).sqrt();
        if length <= f64::EPSILON || !length.is_finite() {
            return Self::IDENTITY;
        }
        Self {
            x: self.x / length,
            y: self.y / length,
            z: self.z / length,
            w: self.w / length,
        }
    }

    #[must_use]
    pub fn slerp(self, destination: Self, progress: f64) -> Self {
        let start = self.normalized();
        let mut end = destination.normalized();
        let mut dot = start.dot(end);
        if dot < 0.0 {
            end = end.scaled(-1.0);
            dot = -dot;
        }
        let amount = progress.clamp(0.0, 1.0);
        if dot > 0.9995 {
            return start
                .scaled(1.0 - amount)
                .added(end.scaled(amount))
                .normalized();
        }
        let angle = dot.clamp(-1.0, 1.0).acos();
        let denominator = angle.sin();
        start
            .scaled(((1.0 - amount) * angle).sin() / denominator)
            .added(end.scaled((amount * angle).sin() / denominator))
            .normalized()
    }

    fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z + self.w * other.w
    }

    fn scaled(self, scale: f64) -> Self {
        Self {
            x: self.x * scale,
            y: self.y * scale,
            z: self.z * scale,
            w: self.w * scale,
        }
    }

    fn added(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
            z: self.z + other.z,
            w: self.w + other.w,
        }
    }
}

impl Default for Quaternion {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
pub struct QuaternionKeyframe {
    pub time: Time,
    pub value: Quaternion,
    pub interpolation: Interpolation,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum QuaternionAnimatable {
    Static { value: Quaternion },
    Animated { keyframes: Vec<QuaternionKeyframe> },
}

impl QuaternionAnimatable {
    pub const fn constant(value: Quaternion) -> Self {
        Self::Static { value }
    }

    #[must_use]
    pub fn evaluate(&self, time: Time) -> Quaternion {
        let Self::Animated { keyframes } = self else {
            let Self::Static { value } = self else {
                unreachable!();
            };
            return value.normalized();
        };
        let next = keyframes.partition_point(|keyframe| keyframe.time <= time);
        if next == 0 {
            return keyframes
                .first()
                .map_or(Quaternion::IDENTITY, |keyframe| keyframe.value.normalized());
        }
        if next == keyframes.len() {
            return keyframes[next - 1].value.normalized();
        }
        let previous = keyframes[next - 1];
        let following = keyframes[next];
        let span = following.time.seconds() - previous.time.seconds();
        if span <= f64::EPSILON {
            return following.value.normalized();
        }
        let progress = ((time.seconds() - previous.time.seconds()) / span).clamp(0.0, 1.0);
        previous
            .value
            .slerp(following.value, previous.interpolation.sample(progress))
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::FRAC_1_SQRT_2;

    use super::*;

    #[test]
    fn string_animation_uses_discrete_values() {
        let animation = StringAnimatable::Animated {
            keyframes: vec![
                StringKeyframe {
                    time: Time::ZERO,
                    value: "first".into(),
                },
                StringKeyframe {
                    time: Time::new(1, 1).unwrap(),
                    value: "second".into(),
                },
            ],
        };
        assert_eq!(animation.evaluate(Time::new(3, 4).unwrap()), "first");
        assert_eq!(animation.evaluate(Time::new(1, 1).unwrap()), "second");
    }

    #[test]
    fn quaternion_animation_slerps_on_the_shortest_path() {
        let animation = QuaternionAnimatable::Animated {
            keyframes: vec![
                QuaternionKeyframe {
                    time: Time::ZERO,
                    value: Quaternion::IDENTITY,
                    interpolation: Interpolation::Linear,
                },
                QuaternionKeyframe {
                    time: Time::new(1, 1).unwrap(),
                    value: Quaternion {
                        x: 0.0,
                        y: 0.0,
                        z: 1.0,
                        w: 0.0,
                    },
                    interpolation: Interpolation::Linear,
                },
            ],
        };
        let value = animation.evaluate(Time::new(1, 2).unwrap());
        assert!((value.z - FRAC_1_SQRT_2).abs() < 1e-10);
        assert!((value.w - FRAC_1_SQRT_2).abs() < 1e-10);
    }

    #[test]
    fn quaternion_normalization_recovers_invalid_zero_length_values() {
        let value = Quaternion {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 0.0,
        };
        assert_eq!(value.normalized(), Quaternion::IDENTITY);
    }
}
