use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

use aster_eval::{
    EvaluationLimits, ExpressionBinding, ExpressionContext, ExpressionLimits, ExpressionProgram,
    TransformTrack,
};
use aster_types::editor::Transform;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
    #[serde(default)]
    transforms: Vec<TransformCase>,
}

#[derive(Deserialize)]
struct Source {
    path: PathBuf,
    sha256: String,
}

#[derive(Deserialize)]
struct Case {
    expression: String,
    context: ExpressionContext,
    accepted: bool,
    value: Option<f64>,
    negative_zero: Option<bool>,
}

#[derive(Deserialize)]
struct TransformCase {
    transform: Transform,
    expressions: BTreeMap<String, String>,
    samples: Vec<TransformSample>,
}

#[derive(Deserialize)]
struct TransformSample {
    time: f64,
    value: BTreeMap<String, serde_json::Value>,
}

impl Oracle {
    fn verify(self) -> Result<(), Box<dyn Error>> {
        assert_eq!(self.version, 1);
        assert!(self.cases.len() >= 26750);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert!(
            self.sources
                .iter()
                .any(|s| s.path == Path::new("src/core/animation/expressions.ts"))
        );
        assert!(
            self.sources
                .iter()
                .any(|s| s.path == Path::new("src/core/animation/beat-functions.ts"))
        );
        for source in self.sources {
            assert_eq!(
                format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
                source.sha256,
                "TS expression source changed"
            );
        }
        let limits = ExpressionLimits::default();
        let mut programs = std::collections::BTreeMap::new();
        for case in self.cases.iter().rev() {
            let program = programs
                .entry(case.expression.clone())
                .or_insert_with(|| ExpressionProgram::compile(&case.expression, &limits));
            let actual = match program {
                Ok(program) => program.evaluate(case.context),
                Err(error) => Err(error.clone()),
            };
            assert_eq!(
                actual.is_ok(),
                case.accepted,
                "{} at {:?}: {:?}",
                case.expression,
                case.context,
                actual
            );
            let binding = ExpressionBinding::compile(&case.expression, &limits);
            if let Some(expected) = case.value {
                let value = actual?;
                assert!(
                    (value - expected).abs() <= 1e-6 + expected.abs() * 1e-5,
                    "{}: native={value}, TS={expected}",
                    case.expression
                );
                if expected == 0.0 {
                    assert_eq!(
                        value.is_sign_negative(),
                        case.negative_zero == Some(true),
                        "{} zero sign",
                        case.expression
                    );
                }
                assert_eq!(binding.evaluate(case.context).to_bits(), value.to_bits());
            } else {
                assert!(!case.accepted);
                assert_eq!(
                    binding.evaluate(case.context).to_bits(),
                    case.context.value.to_bits()
                );
            }
        }
        for case in self.transforms {
            let track = TransformTrack::compile_with_expressions(
                &case.transform,
                &case.expressions,
                &EvaluationLimits::default(),
                &limits,
            )?;
            for sample in case.samples.iter().rev() {
                let actual: BTreeMap<String, serde_json::Value> =
                    serde_json::from_value(serde_json::to_value(track.evaluate(sample.time)?)?)?;
                for (key, expected) in &sample.value {
                    let actual = &actual[key];
                    let (actual, expected) = if key == "opacity" {
                        (
                            vec![actual.as_f64().ok_or("invalid opacity")?],
                            vec![expected.as_f64().ok_or("invalid opacity")?],
                        )
                    } else {
                        (
                            serde_json::from_value::<Vec<f64>>(actual.clone())?,
                            serde_json::from_value::<Vec<f64>>(expected.clone())?,
                        )
                    };
                    assert_eq!(actual.len(), expected.len());
                    for (value, expected) in actual.into_iter().zip(expected) {
                        assert!(
                            (value - expected).abs() <= 1e-6 + expected.abs() * 1e-5,
                            "{key} at {}: native={value}, TS={expected}",
                            sample.time
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "requires an independently captured current-source TS expression oracle"]
fn expressions_match_current_ts_oracle() -> Result<(), Box<dyn Error>> {
    let path = std::env::var("ASTER_EXPRESSION_ORACLE")?;
    let oracle: Oracle = serde_json::from_slice(&fs::read(path)?)?;
    oracle.verify()
}
