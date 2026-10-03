use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

use aster_render_compare::{image::RgbaImage, png::PngCodec};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("aster-compare-cli-{}", Uuid::new_v4()));
        fs::create_dir(&root)?;
        let image = RgbaImage::new(2, 2, vec![0; 16])?;
        fs::write(root.join("reference.png"), PngCodec::encode(&image)?)?;
        Ok(Self { root })
    }

    fn run(&self, candidate: &str, out: &str, extra: &[&str]) -> Result<Output, std::io::Error> {
        Command::new(env!("CARGO_BIN_EXE_aster-render-cli"))
            .current_dir(&self.root)
            .args([
                "compare",
                "--reference",
                "reference.png",
                "--candidate",
                candidate,
                "--tolerance",
                "exact",
                "--out",
                out,
            ])
            .args(extra)
            .output()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn cli_exit_codes_and_atomic_evidence_follow_pixel_outcomes()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let unchanged = fixture.run("reference.png", "equal", &[])?;
    assert_eq!(unchanged.status.code(), Some(0));
    let report: serde_json::Value = serde_json::from_slice(&unchanged.stdout)?;
    assert_eq!(report["report"]["comparison"]["passed"], true);
    for file in ["report.json", "heatmap.png", "contact-sheet.png"] {
        assert!(fixture.root.join("equal").join(file).is_file());
    }
    let mut pixels = vec![0; 16];
    pixels[0] = 1;
    fs::write(
        fixture.root.join("changed.png"),
        PngCodec::encode(&RgbaImage::new(2, 2, pixels)?)?,
    )?;
    let changed = fixture.run("changed.png", "changed", &[])?;
    assert_eq!(changed.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&changed.stdout)?;
    assert_eq!(
        report["report"]["comparison"]["metrics"]["max_abs_channel_error"],
        1
    );
    assert!(fixture.root.join("changed/report.json").is_file());
    let evidence = fs::read(fixture.root.join("equal/report.json"))?;
    let duplicate = fixture.run("changed.png", "equal", &[])?;
    assert_eq!(duplicate.status.code(), Some(2));
    assert_eq!(fs::read(fixture.root.join("equal/report.json"))?, evidence);
    Ok(())
}

#[test]
fn malformed_or_resource_limited_input_cannot_publish_a_pass()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    fs::write(fixture.root.join("broken.png"), b"not a png")?;
    for (candidate, out, extra) in [
        ("broken.png", "broken", Vec::new()),
        ("reference.png", "limited", vec!["--max-pixels", "1"]),
    ] {
        let result = fixture.run(candidate, out, &extra)?;
        assert_eq!(result.status.code(), Some(2));
        let report: serde_json::Value = serde_json::from_slice(&result.stdout)?;
        assert!(report["error"].is_string());
        assert!(!fixture.root.join(out).exists());
    }
    Ok(())
}
