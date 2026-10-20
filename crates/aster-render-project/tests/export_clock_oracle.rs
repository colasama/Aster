use aster_render_project::{NativeProjectDocument, ProjectExportSettings, ProjectRenderLimits};
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: ProjectRenderLimits,
}

#[derive(Deserialize)]
struct Oracle {
    project: PathBuf,
    project_sha256: String,
    cases: Vec<ClockCase>,
}

#[derive(Deserialize)]
struct ClockCase {
    settings: ProjectExportSettings,
    start_time: f64,
    times: Vec<f64>,
}

#[test]
#[ignore = "requires independently captured TS export clock oracle"]
fn absolute_export_frames_match_production_ts_bits() -> Result<(), Box<dyn std::error::Error>> {
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_EXPORT_CLOCK_ORACLE")?)?)?;
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&oracle.project)?)),
        oracle.project_sha256
    );
    let document =
        NativeProjectDocument::open(&oracle.project, Options::try_parse_from(["clock"])?.limits)?;
    assert_eq!(oracle.cases.len(), 20);
    for case in oracle.cases {
        let schedule = document.export_schedule(case.settings)?;
        assert_eq!(schedule.start_time.to_bits(), case.start_time.to_bits());
        assert_eq!(schedule.frames.len(), case.times.len());
        for (frame, expected) in schedule.frames.iter().zip(&case.times) {
            assert_eq!(
                frame.time.to_bits(),
                expected.to_bits(),
                "clock at {}",
                expected
            );
        }
    }
    Ok(())
}
