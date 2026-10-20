mod support;
use aster_eval::{
    AudioAnalysis, AudioAnalysisLimits, AudioMixLimits, AudioMixRequest, AudioPcm,
    CompositionAudioReader, EvaluationLimits, ExpressionLimits, MonoAudioReader, SceneLimits,
    SceneProject,
};
use clap::Parser;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};
use support::Comparison;

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: AudioMixLimits,
}
#[derive(Deserialize)]
struct Proof {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    sources: Vec<Proof>,
    pcm: Vec<AudioPcm>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    project: Value,
    composition: String,
    source_ids: Vec<String>,
    mixes: Vec<Mix>,
    windows: Vec<Window>,
    frames: Vec<Frame>,
}
#[derive(Deserialize)]
struct Mix {
    request: AudioMixRequest,
    expected: Value,
}
#[derive(Deserialize)]
struct Window {
    start: i64,
    data: Vec<f32>,
}
#[derive(Deserialize)]
struct Frame {
    time: f64,
    header: Vec<u32>,
    data: Vec<f32>,
}

#[test]
#[ignore = "requires independent TS project audio mixing oracle"]
fn native_audio_mix_matches_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_AUDIO_MIX_ORACLE")?)?)?;
    for proof in input.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(proof.path))?)),
            proof.sha256
        );
    }
    let pcm = input
        .pcm
        .into_iter()
        .enumerate()
        .map(|(i, p)| (format!("audio-mix-source-{i}"), Arc::new(p)))
        .collect::<BTreeMap<_, _>>();
    let analysis = AudioAnalysis::compile(&AudioAnalysisLimits::default())?;
    for case in input.cases {
        let scene = SceneProject::compile_document(
            &serde_json::to_vec(&case.project)?,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let composition = scene.audio_composition(&case.composition)?;
        assert_eq!(
            composition
                .sources
                .iter()
                .map(|s| s.source_id.clone())
                .collect::<Vec<_>>(),
            case.source_ids,
            "{} source selection",
            case.id
        );
        let reader = CompositionAudioReader {
            composition,
            decoded: pcm.clone(),
            limits: Options::try_parse_from(["test"])?.limits,
        };
        for mix in case.mixes {
            let result = reader
                .composition
                .mix(&reader.decoded, &mix.request, &reader.limits)?;
            Comparison::compare(&serde_json::to_value(result)?, &mix.expected, &case.id);
        }
        for window in case.windows {
            let mut result = vec![0.; window.data.len()];
            reader.read(window.start, &mut result)?;
            Comparison::compare(
                &serde_json::to_value(result)?,
                &serde_json::to_value(window.data)?,
                &case.id,
            );
        }
        for frame in case.frames {
            let result = analysis.evaluate(Some(&reader), frame.time, 0)?;
            assert_eq!(
                result[..4].iter().map(|f| f.to_bits()).collect::<Vec<_>>(),
                frame.header
            );
            Comparison::compare(
                &serde_json::to_value(&result[4..])?,
                &serde_json::to_value(frame.data)?,
                &case.id,
            );
        }
    }
    Ok(())
}
