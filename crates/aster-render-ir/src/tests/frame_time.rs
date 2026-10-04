use crate::{BinaryRationalTime, FrameRate, FrameTime, IrError};

#[test]
fn binary_time_preserves_every_exponent_class_and_boundary_bits() -> Result<(), IrError> {
    for biased_exponent in 0_u64..2047 {
        for fraction in [0, 1, 3, 0x0005_5555_5555_5555, 0x000f_ffff_ffff_ffff] {
            for sign in [0, 1_u64 << 63] {
                let bits = sign | (biased_exponent << 52) | fraction;
                let time = FrameTime::from_f64(f64::from_bits(bits))?;
                time.validate()?;
                assert_eq!(time.to_f64()?.to_bits(), bits);
            }
        }
    }
    for value in [0.1, -1.0 / 3.0, 24000.0 / 1001.0, 30000.0 / 1001.0] {
        assert_eq!(
            FrameTime::from_f64(value)?.to_f64()?.to_bits(),
            value.to_bits()
        );
    }
    assert_eq!(
        FrameTime::from_f64(0.1)?,
        FrameTime::BinaryRational {
            negative: false,
            significand: 3_602_879_701_896_397,
            exponent: -55,
        }
    );
    assert_eq!(
        FrameTime::from_f64(-0.0)?,
        FrameTime::BinaryRational {
            negative: true,
            significand: 0,
            exponent: 0,
        }
    );
    assert_eq!(
        FrameTime::Rational {
            value: -1001,
            scale: 24000
        }
        .to_f64()?
        .to_bits(),
        (-1001.0_f64 / 24000.0).to_bits()
    );
    Ok(())
}

#[test]
fn binary_time_rejects_noncanonical_overflow_and_nonfinite_values() {
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        assert!(matches!(
            FrameTime::from_f64(value),
            Err(IrError::InvalidRational)
        ));
    }
    for (significand, exponent) in [(0, 1), (2, 0), (1, -1075), (1, 1024), (3, 1023)] {
        let time = FrameTime::BinaryRational {
            negative: false,
            significand,
            exponent,
        };
        assert!(matches!(time.validate(), Err(IrError::InvalidRational)));
        assert!(time.to_f64().is_err());
    }
    assert!(matches!(
        FrameTime::BinaryRational {
            negative: false,
            significand: 9_007_199_254_740_992,
            exponent: 0,
        }
        .to_f64(),
        Err(IrError::InvalidSafeInteger)
    ));
}

#[test]
fn time_and_rate_shapes_are_closed_and_require_explicit_tags() {
    for json in [
        r#"{"value":1,"scale":2}"#,
        r#"{"kind":"rational","value":1,"scale":2,"negative":false}"#,
        r#"{"kind":"binary_rational","negative":false,"significand":1,"exponent":0,"scale":1}"#,
        r#"{"kind":"binary_rational","negative":false,"significand":1.5,"exponent":0}"#,
        r#"{"kind":"binary_rational","negative":false,"significand":1,"exponent":0.5}"#,
        r#"{"kind":"future","value":1,"scale":2}"#,
    ] {
        assert!(serde_json::from_str::<FrameTime>(json).is_err(), "{json}");
    }
    for json in [
        r#"{"numerator":30,"denominator":1}"#,
        r#"{"kind":"rational","numerator":30,"denominator":1,"extra":false}"#,
        r#"{"kind":"binary_ratio","numerator":{"kind":"rational","value":1,"scale":1},"denominator":{"kind":"binary_rational","negative":false,"significand":1,"exponent":0}}"#,
    ] {
        assert!(serde_json::from_str::<FrameRate>(json).is_err(), "{json}");
    }
}

#[test]
fn binary_rate_retains_original_scalars_without_a_quotient() -> Result<(), IrError> {
    for (numerator, denominator) in [(29.97, 1.0), (59.94, 0.1), (f64::MAX, f64::from_bits(1))] {
        let rate = FrameRate::BinaryRatio {
            numerator: BinaryRationalTime::from_positive_f64(numerator)?,
            denominator: BinaryRationalTime::from_positive_f64(denominator)?,
        };
        rate.validate()?;
        let encoded =
            serde_json::to_vec(&rate).map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let decoded: FrameRate = serde_json::from_slice(&encoded)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        assert_eq!(decoded, rate);
        let FrameRate::BinaryRatio {
            numerator: decoded_numerator,
            denominator: decoded_denominator,
        } = decoded
        else {
            return Err(IrError::InvalidRational);
        };
        for (scalar, original) in [
            (decoded_numerator, numerator),
            (decoded_denominator, denominator),
        ] {
            let BinaryRationalTime::BinaryRational {
                negative,
                significand,
                exponent,
            } = scalar;
            assert_eq!(
                FrameTime::BinaryRational {
                    negative,
                    significand,
                    exponent
                }
                .to_f64()?
                .to_bits(),
                original.to_bits()
            );
        }
    }
    for value in [0.0, -0.0, -1.0, f64::INFINITY, f64::NAN] {
        assert!(BinaryRationalTime::from_positive_f64(value).is_err());
    }
    let positive = BinaryRationalTime::from_positive_f64(1.0)?;
    for invalid in [
        BinaryRationalTime::BinaryRational {
            negative: true,
            significand: 1,
            exponent: 0,
        },
        BinaryRationalTime::BinaryRational {
            negative: false,
            significand: 0,
            exponent: 0,
        },
        BinaryRationalTime::BinaryRational {
            negative: false,
            significand: 2,
            exponent: 0,
        },
    ] {
        assert!(
            FrameRate::BinaryRatio {
                numerator: invalid,
                denominator: positive
            }
            .validate()
            .is_err()
        );
        assert!(
            FrameRate::BinaryRatio {
                numerator: positive,
                denominator: invalid
            }
            .validate()
            .is_err()
        );
    }
    assert!(
        FrameRate::Rational {
            numerator: 60000,
            denominator: 2002
        }
        .validate()
        .is_err()
    );
    Ok(())
}
