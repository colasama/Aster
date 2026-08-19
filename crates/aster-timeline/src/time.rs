use std::cmp::Ordering;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A rational timestamp measured in seconds.
///
/// Rational time keeps fractional rates such as 23.976 fps exact while supporting arbitrary seeks.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, Serialize)]
pub struct Time {
    value: i64,
    scale: u32,
}

impl Time {
    pub const ZERO: Self = Self { value: 0, scale: 1 };

    pub fn new(value: i64, scale: u32) -> Result<Self, TimeError> {
        if scale == 0 {
            return Err(TimeError::ZeroScale);
        }
        let divisor = gcd(value.unsigned_abs(), u64::from(scale));
        Ok(Self {
            value: value / divisor as i64,
            scale: scale / divisor as u32,
        })
    }

    pub const fn value(self) -> i64 {
        self.value
    }

    pub const fn scale(self) -> u32 {
        self.scale
    }

    pub fn seconds(self) -> f64 {
        self.value as f64 / f64::from(self.scale)
    }

    pub fn from_seconds(seconds: f64) -> Result<Self, TimeError> {
        if !seconds.is_finite() {
            return Err(TimeError::NonFinite);
        }
        Self::new((seconds * 1_000_000.0).round() as i64, 1_000_000)
    }
}

impl PartialEq for Time {
    fn eq(&self, other: &Self) -> bool {
        i128::from(self.value) * i128::from(other.scale)
            == i128::from(other.value) * i128::from(self.scale)
    }
}

impl PartialOrd for Time {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Time {
    fn cmp(&self, other: &Self) -> Ordering {
        (i128::from(self.value) * i128::from(other.scale))
            .cmp(&(i128::from(other.value) * i128::from(self.scale)))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct FrameRate {
    numerator: u32,
    denominator: u32,
}

impl FrameRate {
    pub fn new(numerator: u32, denominator: u32) -> Result<Self, TimeError> {
        if numerator == 0 || denominator == 0 {
            return Err(TimeError::InvalidFrameRate);
        }
        let divisor = gcd(u64::from(numerator), u64::from(denominator)) as u32;
        Ok(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    pub fn fps(self) -> f64 {
        f64::from(self.numerator) / f64::from(self.denominator)
    }

    pub fn frame_time(self, frame: i64) -> Time {
        Time::new(
            frame.saturating_mul(i64::from(self.denominator)),
            self.numerator,
        )
        .expect("validated frame rate")
    }

    pub fn frame_at(self, time: Time) -> i64 {
        (time.seconds() * self.fps()).round() as i64
    }

    pub const fn numerator(self) -> u32 {
        self.numerator
    }

    pub const fn denominator(self) -> u32 {
        self.denominator
    }
}

impl Default for FrameRate {
    fn default() -> Self {
        Self {
            numerator: 60,
            denominator: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum TimeError {
    #[error("time scale cannot be zero")]
    ZeroScale,
    #[error("frame rate numerator and denominator must be non-zero")]
    InvalidFrameRate,
    #[error("time must be finite")]
    NonFinite,
}

const fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    if a == 0 { 1 } else { a }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_frame_rate_round_trips() {
        let rate = FrameRate::new(24_000, 1_001).unwrap();
        let time = rate.frame_time(240);
        assert_eq!(rate.frame_at(time), 240);
        assert!((time.seconds() - 10.01).abs() < f64::EPSILON);
    }

    #[test]
    fn rational_times_compare_exactly() {
        assert_eq!(Time::new(1, 2).unwrap(), Time::new(500, 1_000).unwrap());
        assert!(Time::new(2, 3).unwrap() > Time::new(1, 2).unwrap());
    }
}
