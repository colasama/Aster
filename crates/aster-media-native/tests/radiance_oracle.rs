use aster_media_native::{RadianceEnvironment, RadianceLimits};
use aster_video::CancellationToken;
use base64::Engine;
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: RadianceLimits,
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
    encoded: String,
    expected: Option<Expected>,
}
#[derive(Deserialize)]
struct Expected {
    hash: String,
    sha256: String,
    bytes: usize,
}

#[test]
#[ignore = "requires independent retained Radiance resource oracle"]
fn native_radiance_resources_match_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input = serde_json::from_slice(&fs::read(std::env::var("ASTER_RADIANCE_ORACLE")?)?)?;
    for source in input.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    let options = Options::try_parse_from(["test"])?;
    for case in input.cases {
        let bytes = base64::engine::general_purpose::STANDARD.decode(case.encoded)?;
        let actual =
            RadianceEnvironment::decode(bytes, &options.limits, &CancellationToken::default());
        if let Some(expected) = case.expected {
            let actual = actual?;
            assert_eq!(actual.request().hash.0, expected.hash, "{}", case.id);
            assert_eq!(actual.bytes().len(), expected.bytes, "{}", case.id);
            assert_eq!(
                format!("{:x}", Sha256::digest(actual.bytes())),
                expected.sha256,
                "{}",
                case.id
            );
        } else {
            assert!(actual.is_err(), "{} accepted malformed Radiance", case.id);
        }
    }
    Ok(())
}
