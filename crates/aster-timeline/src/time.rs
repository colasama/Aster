use std::cmp::Ordering;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A rational timestamp measured in seconds.
///
/// Rational time keeps fractional rates such as 23.976 fps exact while supporting arbitrary seeks.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Serialize)]
#[serde(try_from = "TimeFields")]
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
        let divisor = Self::gcd(value.unsigned_abs(), u64::from(scale));
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

    const fn gcd(mut a: u64, mut b: u64) -> u64 {
        while b != 0 {
            let remainder = a % b;
            a = b;
            b = remainder;
        }
        if a == 0 { 1 } else { a }
    }
}

impl Default for Time {
    fn default() -> Self {
        Self::ZERO
    }
}

#[derive(Deserialize, JsonSchema)]
struct TimeFields {
    value: i64,
    scale: u32,
}

impl TryFrom<TimeFields> for Time {
    type Error = TimeError;

    fn try_from(fields: TimeFields) -> Result<Self, Self::Error> {
        Self::new(fields.value, fields.scale)
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
#[serde(try_from = "FrameRateFields")]
pub struct FrameRate {
    numerator: u32,
    denominator: u32,
}

impl FrameRate {
    pub fn new(numerator: u32, denominator: u32) -> Result<Self, TimeError> {
        if numerator == 0 || denominator == 0 {
            return Err(TimeError::InvalidFrameRate);
        }
        let divisor = Time::gcd(u64::from(numerator), u64::from(denominator)) as u32;
        Ok(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    pub fn fps(self) -> f64 {
        f64::from(self.numerator) / f64::from(self.denominator)
    }

    pub fn frame_time(self, frame: i64) -> Time {
        let value = frame.saturating_mul(i64::from(self.denominator));
        let divisor = Time::gcd(value.unsigned_abs(), u64::from(self.numerator));
        Time {
            value: value / divisor as i64,
            scale: self.numerator / divisor as u32,
        }
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

#[derive(Deserialize, JsonSchema)]
struct FrameRateFields {
    numerator: u32,
    denominator: u32,
}

impl TryFrom<FrameRateFields> for FrameRate {
    type Error = TimeError;

    fn try_from(fields: FrameRateFields) -> Result<Self, Self::Error> {
        Self::new(fields.numerator, fields.denominator)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_frame_rate_round_trips() -> Result<(), TimeError> {
        let rate = FrameRate::new(24_000, 1_001)?;
        let time = rate.frame_time(240);
        assert_eq!(rate.frame_at(time), 240);
        assert!((time.seconds() - 10.01).abs() < f64::EPSILON);
        Ok(())
    }

    #[test]
    fn rational_times_compare_exactly() -> Result<(), TimeError> {
        assert_eq!(Time::new(1, 2)?, Time::new(500, 1_000)?);
        assert!(Time::new(2, 3)? > Time::new(1, 2)?);
        Ok(())
    }

    #[test]
    fn default_and_deserialized_times_preserve_valid_rational_values()
    -> Result<(), Box<dyn std::error::Error>> {
        assert_eq!(Time::default().seconds(), 0.0);
        assert!(serde_json::from_str::<Time>(r#"{"value":1,"scale":0}"#).is_err());
        assert!(serde_json::from_str::<FrameRate>(r#"{"numerator":0,"denominator":1}"#).is_err());
        assert!(serde_json::from_str::<FrameRate>(r#"{"numerator":24,"denominator":0}"#).is_err());
        let time: Time = serde_json::from_str(r#"{"value":500,"scale":1000}"#)?;
        assert_eq!(time.value(), 1);
        assert_eq!(time.scale(), 2);
        let rate: FrameRate = serde_json::from_str(r#"{"numerator":48000,"denominator":2002}"#)?;
        assert_eq!(rate, FrameRate::new(24000, 1001)?);
        assert_eq!(rate.frame_time(240), Time::new(1001, 100)?);
        Ok(())
    }
}
