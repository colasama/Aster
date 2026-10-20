use crate::EvaluationError;
use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(transparent)]
pub struct Point2(pub [f64; 2]);

impl Point2 {
    pub(super) fn compile(values: &[Number; 2]) -> Result<Self, EvaluationError> {
        let mut point = [0.0; 2];
        for (out, value) in point.iter_mut().zip(values) {
            *out = value
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| EvaluationError::InvalidScene("invalid path coordinate".into()))?;
        }
        Ok(Self(point))
    }
    pub(super) fn finite(self) -> bool {
        self.0.iter().all(|v| v.is_finite())
    }
    pub(super) fn add(self, b: Self) -> Self {
        Self([self.0[0] + b.0[0], self.0[1] + b.0[1]])
    }
    pub(super) fn subtract(self, b: Self) -> Self {
        Self([self.0[0] - b.0[0], self.0[1] - b.0[1]])
    }
    pub(super) fn scale(self, n: f64) -> Self {
        Self([self.0[0] * n, self.0[1] * n])
    }
    pub(super) fn midpoint(self, b: Self) -> Self {
        self.add(b).scale(0.5)
    }
    pub(super) fn lerp(self, b: Self, n: f64) -> Self {
        self.add(b.subtract(self).scale(n))
    }
    pub(super) fn distance_squared(self, b: Self) -> f64 {
        (self.0[0] - b.0[0]).powi(2) + (self.0[1] - b.0[1]).powi(2)
    }
    pub(super) fn cross(self, b: Self, c: Self) -> f64 {
        (b.0[0] - self.0[0]) * (c.0[1] - self.0[1]) - (b.0[1] - self.0[1]) * (c.0[0] - self.0[0])
    }
    pub(super) fn normalize(self) -> Self {
        let length = self.0[0].hypot(self.0[1]);
        if length <= 1e-7 {
            Self([1.0, 0.0])
        } else {
            Self([self.0[0] / length, self.0[1] / length])
        }
    }
    pub(super) fn line_distance_squared(self, start: Self, end: Self) -> f64 {
        let length = start.distance_squared(end);
        if length <= 1e-7 {
            return self.distance_squared(start);
        }
        let amount = (((self.0[0] - start.0[0]) * (end.0[0] - start.0[0])
            + (self.0[1] - start.0[1]) * (end.0[1] - start.0[1]))
            / length)
            .clamp(0.0, 1.0);
        self.distance_squared(start.lerp(end, amount))
    }
    pub(super) fn inside_triangle(self, a: Self, b: Self, c: Self) -> bool {
        let sides = [a.cross(b, self), b.cross(c, self), c.cross(a, self)];
        sides.iter().all(|v| *v >= -1e-7) || sides.iter().all(|v| *v <= 1e-7)
    }
}
