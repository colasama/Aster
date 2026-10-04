use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{FrameTime, IrError, RationalFrameRate};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BinaryRationalTime {
    BinaryRational {
        #[schemars(extend("const" = false))]
        negative: bool,
        #[schemars(range(min = 1, max = 9007199254740991_u64))]
        significand: u64,
        #[schemars(range(min = -1074, max = 1023))]
        exponent: i16,
    },
}

impl BinaryRationalTime {
    pub fn from_positive_f64(value: f64) -> Result<Self, IrError> {
        let FrameTime::BinaryRational {
            negative,
            significand,
            exponent,
        } = FrameTime::from_f64(value)?
        else {
            return Err(IrError::InvalidRational);
        };
        if negative || significand == 0 {
            return Err(IrError::InvalidRational);
        }
        Ok(Self::BinaryRational {
            negative,
            significand,
            exponent,
        })
    }

    pub fn validate_positive(&self) -> Result<(), IrError> {
        let Self::BinaryRational {
            negative,
            significand,
            exponent,
        } = *self;
        FrameTime::BinaryRational {
            negative,
            significand,
            exponent,
        }
        .validate()?;
        if negative || significand == 0 {
            return Err(IrError::InvalidRational);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FrameRate {
    Rational {
        #[schemars(range(min = 1))]
        numerator: u32,
        #[schemars(range(min = 1))]
        denominator: u32,
    },
    BinaryRatio {
        numerator: BinaryRationalTime,
        denominator: BinaryRationalTime,
    },
}

impl FrameRate {
    pub fn validate(&self) -> Result<(), IrError> {
        match *self {
            Self::Rational {
                numerator,
                denominator,
            } => RationalFrameRate {
                numerator,
                denominator,
            }
            .validate(),
            Self::BinaryRatio {
                numerator,
                denominator,
            } => {
                numerator.validate_positive()?;
                denominator.validate_positive()
            }
        }
    }
}
