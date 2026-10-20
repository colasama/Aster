mod support;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject, TextBaseStyle,
    TextExpressionBinding, TextExpressionContext, TextLayoutUnit, TextSelectorFrame,
    TextSelectorTrack,
};
use aster_types::editor::{Layer, Project, TextAnimator};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    template: Project,
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
    expressions: Vec<Expression>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    layer: Layer,
    settings: TextAnimator,
    units: Vec<TextLayoutUnit>,
    base_styles: Vec<TextBaseStyle>,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    close_time: f64,
    resolution_scale: f64,
    travel: f64,
    time: f64,
    expressions_enabled: bool,
    cache_time: Option<f64>,
    characters: Vec<Value>,
    selectors: Vec<Vec<f64>>,
}
#[derive(Deserialize)]
struct Expression {
    source: String,
    samples: Vec<ExpressionSample>,
}
#[derive(Deserialize)]
struct ExpressionSample {
    context: TextExpressionContext,
    error: bool,
    value: Option<f64>,
    fallback: f64,
}

#[test]
#[ignore = "requires independently captured TS text oracle"]
fn native_text_matches_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_TEXT_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 130 && oracle.expressions.len() >= 120);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for expr in oracle.expressions {
        let program = TextExpressionBinding::compile(&expr.source, &ExpressionLimits::default());
        for sample in expr.samples.iter().rev() {
            let actual = program.evaluate(sample.context);
            assert_eq!(
                actual.is_err(),
                sample.error,
                "expression {} with {:?}: {:?}",
                expr.source,
                sample.context,
                actual
            );
            if !sample.error {
                Comparison::compare(
                    &serde_json::to_value(actual?)?,
                    &serde_json::to_value(sample.value)?,
                    &expr.source,
                );
            }
            Comparison::compare(
                &serde_json::to_value(program.evaluate_or_fallback(sample.context))?,
                &serde_json::to_value(sample.fallback)?,
                "text expression fallback",
            );
        }
    }
    for (i, case) in oracle.cases.iter().enumerate() {
        let mut project = oracle.template.clone();
        project.compositions[0].layers = vec![case.layer.clone()];
        let composition = project.compositions[0].id.clone();
        let scene = SceneProject::compile(
            project,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let track = scene
            .text_animator(&composition, &case.layer.id)?
            .ok_or("missing compiled text")?;
        let selectors = case
            .settings
            .groups
            .iter()
            .map(|g| {
                g.selectors
                    .iter()
                    .map(|s| {
                        TextSelectorTrack::compile(
                            s,
                            &EvaluationLimits::default(),
                            &ExpressionLimits::default(),
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(case.units.len(), case.base_styles.len());
        for sample in case.samples.iter().rev() {
            let frame = track.evaluate(sample.time)?;
            Comparison::compare(
                &serde_json::to_value(track.pixel_travel(
                    &case.layer,
                    &case.units,
                    [sample.time, sample.close_time],
                    sample.resolution_scale,
                )?)?,
                &serde_json::to_value(sample.travel)?,
                &format!("text travel {i} at {}", sample.time),
            );
            Comparison::compare(
                &serde_json::to_value(track.cache_time(sample.time))?,
                &serde_json::to_value(sample.cache_time)?,
                "text cache time",
            );
            assert_eq!(sample.characters.len(), case.units.len());
            assert_eq!(sample.selectors.len(), selectors.len());
            for (g, group) in selectors.iter().enumerate() {
                let frames = group
                    .iter()
                    .map(|s| s.evaluate(sample.time))
                    .collect::<Result<Vec<_>, _>>()?;
                for (u, unit) in case.units.iter().enumerate() {
                    let weight = TextSelectorFrame::combine(
                        &frames,
                        &unit.context,
                        case.settings.groups[g].random_seed.as_f64().ok_or("seed")?,
                        sample.expressions_enabled,
                    );
                    Comparison::compare(
                        &serde_json::to_value(weight)?,
                        &serde_json::to_value(sample.selectors[g][u])?,
                        &format!("selector {i}/{g}/{u} at {}", sample.time),
                    );
                }
            }
            for (u, unit) in case.units.iter().enumerate() {
                let actual = frame.character(
                    &unit.context,
                    &case.base_styles[u],
                    sample.expressions_enabled,
                )?;
                Comparison::compare(
                    &serde_json::to_value(actual)?,
                    &sample.characters[u],
                    &format!("text {i}/{u} at {}", sample.time),
                );
            }
        }
    }
    Ok(())
}
