use aster_eval::{EffectLimits, EffectProgram, EffectTrack, EvaluationLimits, ExpressionLimits};
use aster_types::editor::Effect;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    supported: Vec<String>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    layers: Vec<Layer>,
    expected_native_error: bool,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Layer {
    effects: Vec<Effect>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    time: f64,
    pixel_scale: f64,
    bits: Vec<u32>,
    count: usize,
    uses_blur: bool,
    uses_glow: bool,
    glow_threshold: f64,
}

#[test]
#[ignore = "requires independently captured TS effect program oracle"]
fn native_effect_programs_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_EFFECT_PROGRAM_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.supported.len() >= 86 && oracle.cases.len() >= 260);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (i, case) in oracle.cases.iter().enumerate() {
        let layers = case
            .layers
            .iter()
            .map(|l| {
                l.effects
                    .iter()
                    .map(|e| {
                        EffectTrack::compile(
                            e,
                            &EffectLimits::default(),
                            &EvaluationLimits::default(),
                            &ExpressionLimits::default(),
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        for sample in case.samples.iter().rev() {
            let program = EffectProgram::compile(&layers, sample.time, sample.pixel_scale);
            assert_eq!(
                program.is_err(),
                case.expected_native_error,
                "program {i}: {:?}",
                program.as_ref().err()
            );
            if case.expected_native_error {
                continue;
            }
            let program = program?;
            assert_eq!(program.count, sample.count, "count {i}");
            assert_eq!(program.data.len(), 1024);
            assert!(
                program.data[program.count * 16..]
                    .iter()
                    .all(|v| v.to_bits() == 0)
            );
            let bits: Vec<_> = program.data[..program.count * 16]
                .iter()
                .map(|v| v.to_bits())
                .collect();
            assert_eq!(bits, sample.bits, "operation bits {i} at {}", sample.time);
            assert_eq!(program.uses_blur, sample.uses_blur, "blur {i}");
            assert_eq!(program.uses_glow, sample.uses_glow, "glow {i}");
            assert_eq!(
                program.glow_threshold, sample.glow_threshold,
                "threshold {i}"
            );
        }
    }
    Ok(())
}
