use super::ExpressionError;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Operator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
    Power,
}

impl Operator {
    pub fn binding_power(self) -> (u8, u8) {
        match self {
            Self::Power => (6, 6),
            Self::Multiply | Self::Divide | Self::Remainder => (4, 5),
            _ => (2, 3),
        }
    }

    pub fn evaluate(self, left: f64, right: f64) -> f64 {
        match self {
            Self::Add => left + right,
            Self::Subtract => left - right,
            Self::Multiply => left * right,
            Self::Divide => left / right,
            Self::Remainder => left % right,
            Self::Power => NumericFunction::power(left, right),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum NumericFunction {
    Abs,
    Ceil,
    Cos,
    Floor,
    Round,
    Sin,
    Sqrt,
    Tan,
    Min,
    Max,
    Pow,
    Clamp,
    Linear,
    Ease,
    Beat,
    BeatPhase,
}

impl NumericFunction {
    pub fn resolve_selector(name: &str) -> Result<Self, ExpressionError> {
        Self::resolve(
            name,
            match name {
                "pow" => 2,
                "clamp" => 3,
                "linear" | "ease" => 5,
                _ => 1,
            },
        )
    }

    pub fn evaluate_selector(self, values: &[f64], time: f64) -> Result<f64, ExpressionError> {
        let argument = |index: usize, fallback: f64| values.get(index).copied().unwrap_or(fallback);
        let value = argument(0, 0.0);
        Ok(match self {
            Self::Min => values.iter().copied().fold(f64::INFINITY, Self::minimum),
            Self::Max => values
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, Self::maximum),
            Self::Sqrt => Self::maximum(0.0, value).sqrt(),
            Self::Pow => Self::power(value, argument(1, 0.0)),
            Self::Clamp => Self::minimum(argument(2, 1.0), Self::maximum(argument(1, 0.0), value)),
            Self::Linear | Self::Ease => {
                let raw = (value - argument(1, 0.0)) / (argument(2, 1.0) - argument(1, 0.0));
                let progress = if matches!(self, Self::Ease) {
                    let clamped = if raw.is_finite() {
                        raw.clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    clamped * clamped * (3.0 - 2.0 * clamped)
                } else {
                    raw
                };
                argument(3, 0.0) + (argument(4, 1.0) - argument(3, 0.0)) * progress
            }
            Self::Beat | Self::BeatPhase => {
                self.evaluate(&[value, argument(1, 0.0), argument(2, 1.0)], time)?
            }
            _ => self.evaluate(&[value], time)?,
        })
    }
    pub fn resolve(name: &str, count: usize) -> Result<Self, ExpressionError> {
        match (name, count) {
            ("abs", 1) => Ok(Self::Abs),
            ("ceil", 1) => Ok(Self::Ceil),
            ("cos", 1) => Ok(Self::Cos),
            ("floor", 1) => Ok(Self::Floor),
            ("round", 1) => Ok(Self::Round),
            ("sin", 1) => Ok(Self::Sin),
            ("sqrt", 1) => Ok(Self::Sqrt),
            ("tan", 1) => Ok(Self::Tan),
            ("min", 1..) => Ok(Self::Min),
            ("max", 1..) => Ok(Self::Max),
            ("pow", 2) => Ok(Self::Pow),
            ("clamp", 3) => Ok(Self::Clamp),
            ("linear", 5) => Ok(Self::Linear),
            ("ease", 5) => Ok(Self::Ease),
            ("beat", 1..=3) => Ok(Self::Beat),
            ("beatphase", 1..=3) => Ok(Self::BeatPhase),
            _ => Err(ExpressionError::Syntax(
                "unknown function or argument count".into(),
            )),
        }
    }

    pub fn evaluate(self, values: &[f64], time: f64) -> Result<f64, ExpressionError> {
        let value = values[0];
        Ok(match self {
            Self::Abs => value.abs(),
            Self::Ceil => value.ceil(),
            Self::Cos => value.cos(),
            Self::Floor => value.floor(),
            Self::Sin => value.sin(),
            Self::Sqrt => value.sqrt(),
            Self::Tan => value.tan(),
            Self::Round => Self::round(value),
            Self::Min => values.iter().copied().fold(f64::INFINITY, Self::minimum),
            Self::Max => values
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, Self::maximum),
            Self::Pow => Self::power(value, values[1]),
            Self::Clamp => Self::maximum(values[1], Self::minimum(values[2], value)),
            Self::Linear | Self::Ease => {
                let span = values[2] - values[1];
                let span = if span == 0.0 || span.is_nan() {
                    1.0
                } else {
                    span
                };
                let raw = (value - values[1]) / span;
                let clamped = Self::minimum(1.0, Self::maximum(0.0, raw));
                let progress = if matches!(self, Self::Ease) {
                    clamped * clamped * (3.0 - 2.0 * clamped)
                } else {
                    raw
                };
                values[3] + (values[4] - values[3]) * progress
            }
            Self::Beat | Self::BeatPhase => {
                let offset = match values.get(1) {
                    Some(value) => *value,
                    None => 0.0,
                };
                let division = match values.get(2) {
                    Some(value) => *value,
                    None => 1.0,
                };
                if value.is_nan() || value <= 0.0 || division.is_nan() || division <= 0.0 {
                    return Err(ExpressionError::Syntax(
                        "beat requires positive bpm and division".into(),
                    ));
                }
                let position = ((time - offset) * value * division) / 60.0;
                if matches!(self, Self::Beat) {
                    position.floor()
                } else {
                    position - position.floor()
                }
            }
        })
    }

    pub fn round(value: f64) -> f64 {
        // JS rounds half toward +infinity, preserves negative zero and does
        // not lose the fraction by adding 0.5 before flooring.
        let lower = value.floor();
        let rounded = if value - lower < 0.5 {
            lower
        } else {
            lower + 1.0
        };
        if rounded == 0.0 {
            0.0_f64.copysign(value)
        } else {
            rounded
        }
    }

    pub fn power(base: f64, exponent: f64) -> f64 {
        if exponent.is_nan() || (base.abs() == 1.0 && exponent.is_infinite()) {
            f64::NAN
        } else {
            base.powf(exponent)
        }
    }

    pub(crate) fn minimum(left: f64, right: f64) -> f64 {
        if left.is_nan() || right.is_nan() {
            f64::NAN
        } else if left == 0.0 && right == 0.0 {
            if left.is_sign_negative() || right.is_sign_negative() {
                -0.0
            } else {
                0.0
            }
        } else {
            left.min(right)
        }
    }

    pub(crate) fn maximum(left: f64, right: f64) -> f64 {
        if left.is_nan() || right.is_nan() {
            f64::NAN
        } else if left == 0.0 && right == 0.0 {
            if left.is_sign_positive() || right.is_sign_positive() {
                0.0
            } else {
                -0.0
            }
        } else {
            left.max(right)
        }
    }
}
