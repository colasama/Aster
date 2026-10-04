use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::IrError;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FrameTime {
    Rational {
        #[schemars(range(min = -9007199254740991_i64, max = 9007199254740991_i64))]
        value: i64,
        #[schemars(range(min = 1))]
        scale: u32,
    },
    BinaryRational {
        negative: bool,
        #[schemars(range(max = 9007199254740991_u64))]
        significand: u64,
        #[schemars(range(min = -1074, max = 1023))]
        exponent: i16,
    },
}

impl FrameTime {
    pub fn from_f64(value: f64) -> Result<Self, IrError> {
        let bits = value.to_bits();
        let negative = bits >> 63 != 0;
        let biased_exponent = ((bits >> 52) & 0x7ff) as i16;
        let fraction = bits & 0x000f_ffff_ffff_ffff;
        if biased_exponent == 0x7ff {
            return Err(IrError::InvalidRational);
        }
        let (mut significand, mut exponent) = if biased_exponent == 0 {
            (fraction, -1074)
        } else {
            (fraction | (1_u64 << 52), biased_exponent - 1075)
        };
        if significand == 0 {
            exponent = 0;
        } else {
            let trailing = significand.trailing_zeros();
            significand >>= trailing;
            exponent += trailing as i16;
        }
        Ok(Self::BinaryRational {
            negative,
            significand,
            exponent,
        })
    }

    pub fn validate(&self) -> Result<(), IrError> {
        match *self {
            Self::Rational { value, scale } => RationalTime { value, scale }.validate(),
            Self::BinaryRational {
                significand,
                exponent,
                ..
            } => {
                if significand > 9_007_199_254_740_991 {
                    return Err(IrError::InvalidSafeInteger);
                }
                if !(-1074..=1023).contains(&exponent) {
                    return Err(IrError::InvalidRational);
                }
                if significand == 0 {
                    return if exponent == 0 {
                        Ok(())
                    } else {
                        Err(IrError::InvalidRational)
                    };
                }
                let highest_bit = 63 - significand.leading_zeros() as i32;
                if significand & 1 == 0 || highest_bit + i32::from(exponent) > 1023 {
                    return Err(IrError::InvalidRational);
                }
                Ok(())
            }
        }
    }

    pub fn to_f64(&self) -> Result<f64, IrError> {
        self.validate()?;
        match *self {
            Self::Rational { value, scale } => Ok(value as f64 / f64::from(scale)),
            Self::BinaryRational {
                negative,
                significand,
                exponent,
            } => {
                let sign = u64::from(negative) << 63;
                if significand == 0 {
                    return Ok(f64::from_bits(sign));
                }
                let highest_bit = 63 - significand.leading_zeros();
                let value_exponent = highest_bit as i32 + i32::from(exponent);
                let magnitude = if value_exponent >= -1022 {
                    let biased_exponent = (value_exponent + 1023) as u64;
                    let fraction = (significand << (52 - highest_bit)) & 0x000f_ffff_ffff_ffff;
                    (biased_exponent << 52) | fraction
                } else {
                    significand << (i32::from(exponent) + 1074)
                };
                Ok(f64::from_bits(sign | magnitude))
            }
        }
    }
}

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
