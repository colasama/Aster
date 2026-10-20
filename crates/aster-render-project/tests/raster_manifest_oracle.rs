use aster_eval::{FramePlanRequest, ResourceRequestContext};
use aster_render_project::{NativeProjectDocument, ProjectRasterFrame, ProjectRenderLimits};
use aster_video::CancellationToken;
use clap::Parser;
use serde::Deserialize;
use std::{fs::OpenOptions, io::Write, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    project: ProjectRenderLimits,
}

#[derive(Deserialize)]
struct Request {
    frame: FramePlanRequest,
    context: ResourceRequestContext,
}

#[test]
#[ignore = "requires freshly acquired retained raster files"]
fn native_raster_manifest_authenticates_request_and_pixels()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(std::env::var("ASTER_NATIVE_RASTER_MANIFEST")?);
    let project = PathBuf::from(std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_PROJECT")?);
    let limits = Options::try_parse_from(["test"])?.project;
    let document = NativeProjectDocument::open(&project, limits.clone())?;
    let mut request: Request =
        serde_json::from_slice(&std::fs::read(directory.join("request.json"))?)?;
    let requests = document.resource_requests(&request.frame, &request.context)?;
    let path = directory.join("rasters.json");
    let cancellation = CancellationToken::default();
    let accepted = ProjectRasterFrame::load(&path, &requests, &limits, &cancellation)?;
    assert!(!accepted.pixels.is_empty());
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    assert!(ProjectRasterFrame::load(&path, &requests, &limits, &cancelled).is_err());
    let mut bounded = limits.clone();
    bounded.render_project_pixel_bytes = 1;
    assert!(ProjectRasterFrame::load(&path, &requests, &bounded, &cancellation).is_err());
    request.frame.project_revision += 1;
    let stale = document.resource_requests(&request.frame, &request.context)?;
    assert!(ProjectRasterFrame::load(&path, &stale, &limits, &cancellation).is_err());
    let source: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    for kind in [
        "request",
        "descriptor",
        "pixels",
        "path",
        "binding",
        "frame",
    ] {
        let mut corrupted = source.clone();
        match kind {
            "request" => corrupted["requestSha256"] = "0".repeat(64).into(),
            "descriptor" => corrupted["resources"][0]["hash"] = "0".repeat(64).into(),
            "pixels" => corrupted["pixels"][0]["sha256"] = "0".repeat(64).into(),
            "path" => corrupted["pixels"][0]["file"] = "../outside.bin".into(),
            "binding" => corrupted["bindings"]["unrequested"] = serde_json::Value::Null,
            "frame" => corrupted["pixels"][0]["frame"]["hash"] = "0".repeat(64).into(),
            _ => return Err("unknown negative control".into()),
        }
        let destination = directory.join(format!("reject-{kind}-{}.json", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        file.write_all(&serde_json::to_vec(&corrupted)?)?;
        drop(file);
        assert!(
            ProjectRasterFrame::load(&destination, &requests, &limits, &cancellation).is_err(),
            "{kind}"
        );
    }
    Ok(())
}
