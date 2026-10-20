mod support;
use aster_eval::{ClonerLimits, ClonerTrack, EvaluatedTransform};
use aster_types::editor::Cloner;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
    invalid: Vec<Cloner>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    settings: Cloner,
    transform: Transform,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Transform {
    position: [f64; 3],
    rotation: [f64; 3],
    scale: [f64; 3],
    anchor: [f64; 3],
    opacity: f64,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    spectrum: Option<Vec<f32>>,
    instances: Value,
    data: Vec<f32>,
    composed: Value,
}

#[test]
#[ignore = "requires independently captured TS cloner oracle"]
fn native_cloners_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_CLONER_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 40 && oracle.invalid.len() >= 7);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for invalid in oracle.invalid {
        assert!(ClonerTrack::compile(&invalid, &ClonerLimits::default()).is_err());
    }
    for (index, case) in oracle.cases.iter().enumerate() {
        let track = ClonerTrack::compile(&case.settings, &ClonerLimits::default())?;
        let t = &case.transform;
        let transform = EvaluatedTransform {
            position: t.position,
            rotation: t.rotation,
            scale: t.scale,
            anchor: t.anchor,
            opacity: t.opacity,
        };
        for sample in case.samples.iter().rev() {
            let frame = track.evaluate(sample.time, sample.spectrum.as_deref())?;
            Comparison::compare(
                &serde_json::to_value(&*frame.instances)?,
                &sample.instances,
                &format!("cloner {index}"),
            );
            Comparison::compare(
                &serde_json::to_value(frame.instance_data())?,
                &serde_json::to_value(&sample.data)?,
                &format!("cloner data {index}"),
            );
            let composed: Vec<_> = frame
                .instances
                .iter()
                .map(|i| i.compose(&transform))
                .collect();
            Comparison::compare(
                &serde_json::to_value(composed)?,
                &sample.composed,
                &format!("cloner composition {index}"),
            );
        }
        assert!(track.evaluate(f64::NAN, None).is_err());
        let limits = ClonerLimits {
            max_cloner_instances: 0,
            ..ClonerLimits::default()
        };
        assert!(ClonerTrack::compile(&case.settings, &limits).is_err());
    }
    Ok(())
}
