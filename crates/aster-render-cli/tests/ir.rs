use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

use aster_render_ir::{DecodeLimits, FplnCodec, FramePlanSchema, IrFixture};
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Result<Self, std::io::Error> {
        let root = std::env::temp_dir().join(format!("aster-ir-cli-{}", Uuid::new_v4()));
        fs::create_dir(&root)?;
        Ok(Self { root })
    }

    fn run(&self, arguments: &[&str]) -> Result<Output, std::io::Error> {
        Command::new(env!("CARGO_BIN_EXE_aster-render-cli"))
            .current_dir(&self.root)
            .arg("ir")
            .args(arguments)
            .output()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn cli_emits_schema_and_roundtrips_typed_binary_without_overwriting_outputs()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let schema = fixture.run(&["schema", "--out", "schema.json"])?;
    assert_eq!(schema.status.code(), Some(0));
    assert_eq!(
        fs::read(fixture.root.join("schema.json"))?,
        FramePlanSchema::emit()?
    );
    let generated = fixture.run(&["fixture", "--output", "fixture.fpln"])?;
    assert_eq!(generated.status.code(), Some(0));
    let bytes = fs::read(fixture.root.join("fixture.fpln"))?;
    let report: serde_json::Value = serde_json::from_slice(&generated.stdout)?;
    assert_eq!(report["kind"], "ir_fixture");
    assert_eq!(report["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    let roundtrip = fixture.run(&[
        "roundtrip",
        "--input",
        "fixture.fpln",
        "--output",
        "roundtrip.fpln",
    ])?;
    assert_eq!(roundtrip.status.code(), Some(0));
    assert_eq!(fs::read(fixture.root.join("roundtrip.fpln"))?, bytes);
    let metadata = fixture.run(&["dump", "--input", "roundtrip.fpln"])?;
    assert_eq!(metadata.status.code(), Some(0));
    let decoded = FplnCodec::decode(bytes.clone(), &DecodeLimits::default())?;
    let actual: serde_json::Value = serde_json::from_slice(&metadata.stdout)?;
    assert_eq!(actual, serde_json::to_value(decoded.metadata)?);
    let duplicate = fixture.run(&["schema", "--out", "roundtrip.fpln"])?;
    assert_eq!(duplicate.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&duplicate.stdout)?;
    assert_eq!(report["code"], "io_error");
    assert_eq!(fs::read(fixture.root.join("roundtrip.fpln"))?, bytes);
    assert!(fs::read_dir(&fixture.root)?.all(|entry| {
        entry.is_ok_and(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
    }));
    Ok(())
}

#[test]
fn cli_preserves_typed_failures_and_applies_explicit_limits_before_publishing()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let (mut metadata, blobs) = IrFixture::parts()?;
    metadata.resources.clear();
    let borrowed = blobs.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let bytes = FplnCodec::encode(metadata, &borrowed, &DecodeLimits::default())?;
    fs::write(fixture.root.join("empty-resources.fpln"), &bytes)?;
    let accepted = fixture.run(&[
        "roundtrip",
        "--input",
        "empty-resources.fpln",
        "--output",
        "accepted.fpln",
        "--max-resource-references",
        "0",
    ])?;
    assert_eq!(accepted.status.code(), Some(0));
    let mut version = bytes.clone();
    version[4..6].copy_from_slice(&2_u16.to_le_bytes());
    fs::write(fixture.root.join("version.fpln"), version)?;
    let budget = (bytes.len() - 1).to_string();
    for (input, output, code, flags) in [
        (
            "version.fpln",
            "invalid.fpln",
            "unsupported_version",
            Vec::new(),
        ),
        (
            "empty-resources.fpln",
            "limited.fpln",
            "limit_exceeded",
            vec![
                "--max-container-bytes",
                budget.as_str(),
                "--max-metadata-bytes",
                "32",
            ],
        ),
        (
            "empty-resources.fpln",
            "limits.fpln",
            "limit_exceeded",
            vec![
                "--max-container-bytes",
                "100",
                "--max-metadata-bytes",
                "101",
            ],
        ),
    ] {
        let mut arguments = vec!["roundtrip", "--input", input, "--output", output];
        arguments.extend(flags);
        let failure = fixture.run(&arguments)?;
        assert_eq!(failure.status.code(), Some(2));
        let report: serde_json::Value = serde_json::from_slice(&failure.stdout)?;
        assert_eq!(report["schema_version"], 1);
        assert_eq!(report["status"], "failed");
        assert_eq!(report["code"], code);
        assert!(!fixture.root.join(output).exists());
    }
    Ok(())
}
