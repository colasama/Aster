use aster_project::{
    MediaSourceLimits, MediaSourceReader, ProjectMediaCatalog, ProjectMediaCatalogLimits,
    ProjectMediaPayload, SequenceSelection,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Deserialize)]
struct FileProof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Oracle {
    sources: Vec<FileProof>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    path: PathBuf,
    sha256: String,
    entries: Vec<Entry>,
    sequence_samples: Vec<SequenceSample>,
}
#[derive(Deserialize)]
struct Entry {
    payload_id: Option<String>,
    frame: Option<i64>,
    source_id: String,
    sha256: String,
    byte_identity: String,
    byte_length: usize,
    storage: String,
}
#[derive(Deserialize)]
struct SequenceSample {
    source_id: String,
    time: f64,
    expected: Option<SequenceSelection>,
}

#[test]
#[ignore = "requires the authenticated TS project-media oracle"]
fn project_media_bytes_match_ts_oracle() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_PROJECT_MEDIA_ORACLE")?)?)?;
    for source in &oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(&source.path))?)),
            source.sha256
        );
    }
    assert!(!oracle.cases.is_empty());
    for case in oracle.cases {
        let path = root.join(&case.path);
        let raw = fs::read(&path)?;
        assert_eq!(format!("{:x}", Sha256::digest(&raw)), case.sha256);
        let catalog = ProjectMediaCatalog::from_slice(&raw, &ProjectMediaCatalogLimits::default())?;
        let mut reader = MediaSourceReader::new(
            path.parent().ok_or("project parent absent")?,
            MediaSourceLimits::default(),
        )?;
        for expected in case.entries {
            let binding = catalog.bind(&expected.source_id)?;
            assert_eq!(
                binding.entry.as_ref().map(|e| &e.payload_id),
                expected.payload_id.as_ref()
            );
            let snapshot = binding.read(&mut reader, expected.frame, 536_870_912)?;
            assert_eq!(snapshot.bytes.len(), expected.byte_length);
            assert_eq!(snapshot.sha256, expected.sha256);
            assert_eq!(snapshot.byte_identity, expected.byte_identity);
            assert_eq!(snapshot.path.is_none(), expected.storage == "inline");
        }
        for sample in case.sequence_samples {
            let binding = catalog.bind(&sample.source_id)?;
            let Some(ProjectMediaPayload::ImageSequence(sequence)) = binding.payload.as_deref()
            else {
                return Err("sequence payload absent".into());
            };
            assert_eq!(sequence.select(sample.time).ok(), sample.expected);
        }
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(path)?)),
            case.sha256
        );
    }
    Ok(())
}
