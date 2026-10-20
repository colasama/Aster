mod support;
use aster_eval::{
    EffectFrame, EffectLimits, EffectTrack, EvaluationLimits, ExpressionLimits, PixelParameter,
};
use aster_types::editor::Effect;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
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
    effect: Effect,
    queries: Vec<Query>,
    pixel_parameters: Vec<PixelParameter>,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Query {
    key: String,
    fallback: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    time: f64,
    pixel_scale: f64,
    values: Vec<f64>,
    colors: Vec<[f64; 3]>,
    scaled_values: Vec<f64>,
    gradient_colors: Vec<f64>,
    mask: Option<[f32; 8]>,
}

#[test]
#[ignore = "requires independently captured TS effect input oracle"]
fn native_effect_inputs_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_EFFECT_INPUT_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 200);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (i, case) in oracle.cases.iter().enumerate() {
        let track = EffectTrack::compile(
            &case.effect,
            &EffectLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples.iter().rev() {
            let mut frame = track.evaluate(sample.time)?;
            let values: Vec<_> = case
                .queries
                .iter()
                .map(|q| frame.value(&q.key, q.fallback))
                .collect();
            Comparison::compare(
                &serde_json::to_value(&values)?,
                &serde_json::to_value(&sample.values)?,
                &format!("effect {i} at {}", sample.time),
            );
            let colors: Vec<_> = values
                .into_iter()
                .map(EffectFrame::color_channels)
                .collect();
            Comparison::compare(
                &serde_json::to_value(colors)?,
                &serde_json::to_value(&sample.colors)?,
                "effect color channels",
            );
            if case.effect.effect_type == "multi-stop-gradient" {
                let colors: Vec<_> = (1..=5)
                    .map(|n| frame.gradient_color(&format!("color{n}"), 0x123456 as f64))
                    .collect();
                assert_eq!(
                    colors, sample.gradient_colors,
                    "gradient {i} at {}",
                    sample.time
                );
            }
            let mask = track
                .mask
                .as_ref()
                .map(|mask| mask.uniforms(sample.pixel_scale))
                .transpose()?;
            assert_eq!(mask, sample.mask, "mask {i} at {}", sample.time);
            frame.scale_pixels(&case.pixel_parameters, sample.pixel_scale)?;
            let values: Vec<_> = case
                .queries
                .iter()
                .map(|q| frame.value(&q.key, q.fallback))
                .collect();
            Comparison::compare(
                &serde_json::to_value(values)?,
                &serde_json::to_value(&sample.scaled_values)?,
                &format!("scaled effect {i} at {}", sample.time),
            );
        }
    }
    Ok(())
}
