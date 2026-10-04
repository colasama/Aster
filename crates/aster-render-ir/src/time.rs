use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::IrError;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RationalTime {
    #[schemars(range(min = -9007199254740991_i64, max = 9007199254740991_i64))]
    pub value: i64,
    #[schemars(range(min = 1))]
    pub scale: u32,
}

impl RationalTime {
    pub fn validate(&self) -> Result<(), IrError> {
        if self.value.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(IrError::InvalidSafeInteger);
        }
        if self.scale == 0 || Self::gcd(self.value.unsigned_abs(), u64::from(self.scale)) != 1 {
            return Err(IrError::InvalidRational);
        }
        Ok(())
    }

    pub(crate) fn gcd(mut a: u64, mut b: u64) -> u64 {
        while b != 0 {
            let remainder = a % b;
            a = b;
            b = remainder;
        }
        a
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RationalFrameRate {
    #[schemars(range(min = 1))]
    pub numerator: u32,
    #[schemars(range(min = 1))]
    pub denominator: u32,
}

impl RationalFrameRate {
    pub fn validate(&self) -> Result<(), IrError> {
        if self.numerator == 0
            || self.denominator == 0
            || RationalTime::gcd(u64::from(self.numerator), u64::from(self.denominator)) != 1
        {
            return Err(IrError::InvalidRational);
        }
        Ok(())
    }

    pub fn time_at_frame(&self, frame: i64) -> Result<RationalTime, IrError> {
        self.validate()?;
        if frame.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(IrError::InvalidSafeInteger);
        }
        let value = i128::from(frame) * i128::from(self.denominator);
        let mut a = value.unsigned_abs();
        let mut b = u128::from(self.numerator);
        while b != 0 {
            let remainder = a % b;
            a = b;
            b = remainder;
        }
        let divisor = i128::try_from(a).map_err(|_| IrError::ArithmeticOverflow)?;
        let result = RationalTime {
            value: i64::try_from(value / divisor).map_err(|_| IrError::InvalidSafeInteger)?,
            scale: u32::try_from(i128::from(self.numerator) / divisor)
                .map_err(|_| IrError::ArithmeticOverflow)?,
        };
        result.validate()?;
        Ok(result)
    }
}
