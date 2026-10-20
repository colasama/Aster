use std::{error::Error, fs, path::PathBuf};

use aster_eval::{EvaluationLimits, ScalarTrack, TransformTrack};
use aster_types::editor::{Animatable, Transform};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
    invalid: Vec<Animatable>,
    transforms: Vec<TransformCase>,
}

#[derive(Deserialize)]
struct Source {
    path: PathBuf,
    sha256: String,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    property: Animatable,
    samples: Vec<Sample>,
}

#[derive(Deserialize)]
struct Sample {
    time: f64,
    value: f64,
    speed: f64,
}

#[derive(Deserialize)]
struct TransformCase {
    transform: Transform,
    samples: Vec<TransformSample>,
}

#[derive(Deserialize)]
struct TransformSample {
    time: f64,
    value: TransformValue,
}

#[derive(Deserialize)]
struct TransformValue {
    position: [f64; 3],
    rotation: [f64; 3],
    scale: [f64; 3],
    anchor: [f64; 3],
    opacity: f64,
}

impl Oracle {
    fn close(actual: f64, expected: f64, context: &str) {
        let tolerance = 1e-6 + expected.abs() * 1e-5;
        assert!(actual.is_finite() && expected.is_finite());
        assert!(
            (actual - expected).abs() <= tolerance,
            "{context}: native={actual}, TS={expected}, tolerance={tolerance}"
        );
    }

    fn verify(self) -> Result<(), Box<dyn Error>> {
        assert_eq!(self.version, 1);
        assert!(self.cases.len() >= 141);
        assert!(self.invalid.len() >= 9);
        assert!(!self.transforms.is_empty());
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_eq!(self.sources.len(), 3);
        for source in self.sources {
            let digest = format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?));
            assert_eq!(digest, source.sha256, "TS oracle source changed");
        }
        let limits = EvaluationLimits::default();
        for case in self.cases {
            assert!(case.samples.len() >= 64);
            let track = ScalarTrack::compile(&case.property, &limits)?;
            // Reverse traversal verifies that seeking never depends on a prior frame.
            for sample in case.samples.iter().rev() {
                Self::close(
                    track.evaluate(sample.time)?,
                    sample.value,
                    &format!("{} value at {}", case.id, sample.time),
                );
                Self::close(
                    track.speed(sample.time)?,
                    sample.speed,
                    &format!("{} speed at {}", case.id, sample.time),
                );
            }
        }
        for property in self.invalid {
            assert!(ScalarTrack::compile(&property, &limits).is_err());
        }
        for case in self.transforms {
            let track = TransformTrack::compile(&case.transform, &limits)?;
            for sample in case.samples.iter().rev() {
                let actual = track.evaluate(sample.time)?;
                for (actual, expected) in [
                    (actual.position, sample.value.position),
                    (actual.rotation, sample.value.rotation),
                    (actual.scale, sample.value.scale),
                    (actual.anchor, sample.value.anchor),
                ] {
                    for (actual, expected) in actual.into_iter().zip(expected) {
                        Self::close(actual, expected, "transform channel");
                    }
                }
                Self::close(actual.opacity, sample.value.opacity, "opacity");
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "requires an independently captured current-source TS scalar oracle"]
fn scalar_and_transform_match_current_ts_oracle() -> Result<(), Box<dyn Error>> {
    let path = std::env::var("ASTER_SCALAR_ORACLE")?;
    let oracle: Oracle = serde_json::from_slice(&fs::read(path)?)?;
    oracle.verify()
}
