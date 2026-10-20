use aster_eval::AudioMixRequest;
use aster_media_native::ProjectMediaTools;
use aster_render_project::{
    NativeProjectAudio, NativeProjectDocument, ProjectAudioLimits, ProjectRenderLimits,
};
use aster_video::CancellationToken;
use clap::Parser;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    project: ProjectRenderLimits,
    #[command(flatten)]
    audio: ProjectAudioLimits,
}
#[derive(Deserialize)]
struct Proof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    sources: Vec<Proof>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: Proof,
    composition: String,
    sources: usize,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    request: AudioMixRequest,
    mix: Value,
    header: Vec<u32>,
    analysis: Vec<f32>,
}
struct Comparison;
impl Comparison {
    fn values(actual: &Value, expected: &Value, label: &str) {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => {
                let a = a.as_f64().expect("finite number");
                let b = b.as_f64().expect("finite number");
                assert!(
                    (a - b).abs() <= 1e-6 + b.abs() * 1e-5,
                    "{label}: native {a}, TS {b}"
                );
            }
            (Value::Array(a), Value::Array(b)) => {
                assert_eq!(a.len(), b.len());
                for (a, b) in a.iter().zip(b) {
                    Self::values(a, b, label);
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                assert_eq!(a.len(), b.len());
                for (key, b) in b {
                    Self::values(a.get(key).expect("field absent"), b, label);
                }
            }
            _ => assert_eq!(actual, expected, "{label}"),
        }
    }
}
#[test]
#[ignore = "requires retained TS mixing of exact WAV samples and native codec tools"]
fn native_project_audio_matches_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_PROJECT_AUDIO_ORACLE")?)?)?;
    for proof in input.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(proof.path))?)),
            proof.sha256
        );
    }
    let token = CancellationToken::default();
    for case in input.cases {
        let path = root.join(case.project.path);
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(&path)?)),
            case.project.sha256
        );
        let options = Options::try_parse_from(["test"])?;
        let document = NativeProjectDocument::open(&path, options.project)?;
        let session = NativeProjectAudio::new(
            &document,
            &case.composition,
            ProjectMediaTools {
                ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
                ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
            },
            options.audio,
            &token,
        )?;
        assert_eq!(session.receipts.len(), case.sources);
        for sample in case.samples {
            Comparison::values(
                &serde_json::to_value(session.mix(&sample.request, &token)?)?,
                &sample.mix,
                &case.id,
            );
            let frame = session.analysis_frame(sample.time, &token)?;
            assert_eq!(
                frame[..4].iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                sample.header
            );
            Comparison::values(
                &serde_json::to_value(&frame[4..])?,
                &serde_json::to_value(sample.analysis)?,
                &case.id,
            );
        }
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert!(session.analysis_frame(0., &cancelled).is_err());
    }
    Ok(())
}
