use aster_eval::{FramePlanRequest, ResourceRequestContext};
use aster_render_project::{
    NativeProjectDocument, NativeRasterProvider, ProjectRasterFrame, ProjectRenderLimits,
    RasterProviderOptions,
};
use aster_video::CancellationToken;
use clap::Parser;
use serde::Deserialize;
use std::{collections::BTreeSet, fs, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: ProjectRenderLimits,
}
#[derive(Deserialize)]
struct Request {
    frame: FramePlanRequest,
    context: ResourceRequestContext,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Assignment {
    case: Case,
    project_path: PathBuf,
}
#[derive(Deserialize)]
struct Case {
    id: String,
}
#[derive(Deserialize)]
struct Capture {
    assignments: Vec<Assignment>,
}

#[test]
#[ignore = "requires Electron, retained raster bundle, native bridge and independent captures"]
fn live_raster_provider_matches_fresh_reference_and_cleans_up()
-> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::var("ASTER_NATIVE_RASTER_CAPTURE")?);
    let config: RasterProviderOptions =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_NATIVE_RASTER_PROVIDER")?)?)?;
    let capture: Capture = serde_json::from_slice(&fs::read(root.join("config.json"))?)?;
    let selected: Vec<String> = serde_json::from_str(&std::env::var("ASTER_NATIVE_RASTER_CASES")?)?;
    assert!(!selected.is_empty());
    let options = Options::try_parse_from(["test"])?;
    let temporary = std::env::temp_dir();
    let before = fs::read_dir(&temporary)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("aster-native-raster-")
        })
        .map(|e| e.path())
        .collect::<BTreeSet<_>>();
    for id in &selected {
        let assignment = capture
            .assignments
            .iter()
            .find(|a| &a.case.id == id)
            .ok_or("case absent")?;
        let document =
            NativeProjectDocument::open(&assignment.project_path, options.limits.clone())?;
        let cancellation = CancellationToken::default();
        let mut provider = NativeRasterProvider::start(
            config.clone(),
            &assignment.project_path,
            &document.authored_sha256,
            options.limits.clone(),
            &cancellation,
        )?;
        for index in 0..6 {
            let directory = root.join(id).join(index.to_string());
            let mut request: Request =
                serde_json::from_slice(&fs::read(directory.join("request.json"))?)?;
            request.context.locale = provider.ready.locale.clone();
            request.context.layouts = provider.ready.layouts.clone();
            request.context.maximum_raster_dimension = provider.ready.maximum_dimension;
            let requests = document.resource_requests(&request.frame, &request.context)?;
            let expected = ProjectRasterFrame::load(
                &directory.join("rasters.json"),
                &requests,
                &options.limits,
                &cancellation,
            )?;
            let actual = provider.acquire(&requests, &cancellation)?;
            assert_eq!(
                actual.request_sha256, expected.request_sha256,
                "{id}/{index}"
            );
            assert_eq!(actual.bindings, expected.bindings, "{id}/{index}");
            for (actual, expected) in [
                (&actual.text_bounds, &expected.text_bounds),
                (&actual.motion_text_bounds, &expected.motion_text_bounds),
            ] {
                assert!(actual.keys().eq(expected.keys()), "{id}/{index}");
                for (actual, expected) in actual.values().zip(expected.values()) {
                    assert_eq!(
                        [actual.x, actual.y, actual.width, actual.height],
                        [expected.x, expected.y, expected.width, expected.height],
                        "{id}/{index}"
                    );
                }
            }
            assert_eq!(actual.temporal.len(), expected.temporal.len());
            for (actual, expected) in actual.temporal.iter().zip(&expected.temporal) {
                assert_eq!(
                    (actual.width, actual.height, &actual.output),
                    (expected.width, expected.height, &expected.output)
                );
                assert_eq!(actual.samples.len(), expected.samples.len());
                for (actual, expected) in actual.samples.iter().zip(&expected.samples) {
                    assert_eq!(
                        (&actual.hash, actual.weight.to_bits()),
                        (&expected.hash, expected.weight.to_bits())
                    );
                }
            }
            assert_eq!(actual.resources.len(), expected.resources.len());
            for (actual, expected) in actual.resources.iter().zip(&expected.resources) {
                assert_eq!(actual.request(), expected.request());
                assert_eq!(actual.bytes(), expected.bytes());
            }
            assert_eq!(actual.pixels.len(), expected.pixels.len());
            for (actual, expected) in actual.pixels.iter().zip(&expected.pixels) {
                assert_eq!(actual.frame, expected.frame);
                assert_eq!(actual.pixels.request(), expected.pixels.request());
                assert_eq!(
                    actual.pixels.bytes(),
                    expected.pixels.bytes(),
                    "{id}/{index}"
                );
            }
        }
        let request: Request =
            serde_json::from_slice(&fs::read(root.join(id).join("5/request.json"))?)?;
        let requests = document.resource_requests(&request.frame, &request.context)?;
        cancellation.cancel();
        assert!(provider.acquire(&requests, &cancellation).is_err());
        assert!(
            provider
                .acquire(&requests, &CancellationToken::default())
                .is_err()
        );
        drop(provider);
    }
    let after = fs::read_dir(&temporary)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("aster-native-raster-")
        })
        .map(|e| e.path())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        after, before,
        "owned raster profiles remain after cancellation"
    );
    Ok(())
}
