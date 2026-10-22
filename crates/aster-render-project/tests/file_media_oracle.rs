use aster_eval::{FramePlanRequest, ResourceRequestContext};
use aster_media_native::{ProjectMediaLimits, ProjectMediaTools};
use aster_render_ir::{MediaKind, ResourceDescriptor, ResourceHash, ResourceMessage};
use aster_render_project::{NativeProjectDocument, NativeProjectFileMedia, ProjectRenderLimits};
use aster_video::CancellationToken;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    project: ProjectRenderLimits,
    #[command(flatten)]
    media: ProjectMediaLimits,
}
#[derive(Deserialize)]
struct Proof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    sources: Vec<Proof>,
    ffmpeg: Proof,
    ffprobe: Proof,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: Proof,
    context: ResourceRequestContext,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    index: usize,
    frame: FramePlanRequest,
    resources: Proof,
}
#[derive(Serialize)]
struct Observation {
    case: String,
    index: usize,
    bindings: usize,
    resources: usize,
    pixels: usize,
}
#[derive(Serialize)]
struct Report {
    scope: &'static str,
    decoded_pixels: bool,
    observations: Vec<Observation>,
}

impl Proof {
    fn read(&self, root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            self.sha256,
            "{}",
            self.path.display()
        );
        Ok(bytes)
    }
}
#[test]
#[ignore = "requires authenticated TS media references and native codec tools"]
fn native_ordered_file_resources_match_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input = serde_json::from_slice(&fs::read(std::env::var(
        "ASTER_NATIVE_PROJECT_FILE_ORACLE",
    )?)?)?;
    for proof in input.sources.iter().chain([&input.ffmpeg, &input.ffprobe]) {
        proof.read(&root)?;
    }
    let preview = std::env::var("ASTER_NATIVE_PROJECT_FILE_PREVIEW").as_deref() == Ok("1");
    let decode = std::env::var("ASTER_NATIVE_PROJECT_FILE_DECODE").as_deref() == Ok("1");
    let token = CancellationToken::default();
    let mut report = Report {
        scope: if preview {
            "native-time-addressed-preview-file-acquisition"
        } else {
            "native-ordered-file-resource-acquisition"
        },
        decoded_pixels: decode,
        observations: Vec::new(),
    };
    for case in input.cases {
        case.project.read(&root)?;
        let options = Options::try_parse_from(["test"])?;
        let document =
            NativeProjectDocument::open(&root.join(&case.project.path), options.project)?;
        assert_eq!(document.authored_sha256, case.project.sha256);
        let frames = case
            .samples
            .iter()
            .map(|s| s.frame.clone())
            .collect::<Vec<_>>();
        let tools = ProjectMediaTools {
            ffmpeg: root.join(&input.ffmpeg.path),
            ffprobe: root.join(&input.ffprobe.path),
        };
        let mut session = if preview {
            let mut initial = frames.first().ok_or("sample absent")?.clone();
            initial.time = -1.0;
            let requests = document.resource_requests(&initial, &case.context)?;
            assert!(
                !requests.operations.iter().any(|operation| matches!(
                    operation,
                    aster_eval::ResourcePreparationOperation::Media { .. }
                )),
                "preview admission must start outside active media times"
            );
            NativeProjectFileMedia::new_preview(
                document,
                &initial,
                &case.context,
                tools,
                options.media,
                &token,
            )?
        } else {
            NativeProjectFileMedia::new(
                document,
                &frames,
                &case.context,
                tools,
                options.media,
                &token,
            )?
        };
        for sample in &case.samples {
            let expected: Vec<ResourceMessage> =
                serde_json::from_slice(&sample.resources.read(&root)?)?;
            let expected = expected
                .into_iter()
                .filter_map(|m| match m {
                    ResourceMessage::PutResource(r) => Some((r.hash.clone(), r)),
                    _ => None,
                })
                .collect::<BTreeMap<_, _>>();
            let result = session
                .acquire(&sample.frame, &case.context, decode, &token)
                .map_err(|e| format!("{} sample {}: {e}", case.id, sample.index))?;
            let actual = result
                .resources
                .iter()
                .map(|r| (r.request().hash.clone(), r))
                .collect::<BTreeMap<_, _>>();
            let file_sources = expected
                .iter()
                .filter_map(|(hash, r)| match &r.descriptor {
                    ResourceDescriptor::MediaSource(s) if s.media_kind != MediaKind::Raster => {
                        Some(hash.clone())
                    }
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            let required = expected
                .iter()
                .filter_map(|(hash, r)| match &r.descriptor {
                    ResourceDescriptor::MediaFrame(f) if file_sources.contains(&f.source) => {
                        Some(hash.clone())
                    }
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            assert_eq!(
                result
                    .bindings
                    .values()
                    .flatten()
                    .cloned()
                    .collect::<BTreeSet<_>>(),
                required,
                "{} sample {} file frame coverage",
                case.id,
                sample.index
            );
            for resource in &result.resources {
                assert_eq!(
                    Some(resource.request()),
                    expected.get(&resource.request().hash),
                    "{} at {}",
                    case.id,
                    sample.index
                );
            }
            for hash in result.bindings.values().flatten() {
                assert!(actual.contains_key(hash));
            }
            if decode {
                let pixels = result
                    .pixels
                    .iter()
                    .map(|p| (&p.frame, &p.pixels))
                    .collect::<BTreeMap<_, _>>();
                for hash in result.bindings.values().flatten() {
                    assert!(pixels.contains_key(hash));
                }
                for pixel in &result.pixels {
                    let resource = pixel.pixels.request();
                    assert_eq!(
                        ResourceHash::for_resource(
                            resource.kind,
                            &resource.descriptor,
                            pixel.pixels.bytes()
                        )?,
                        resource.hash
                    );
                }
            } else {
                assert!(result.pixels.is_empty());
            }
            report.observations.push(Observation {
                case: case.id.clone(),
                index: sample.index,
                bindings: result.bindings.len(),
                resources: result.resources.len(),
                pixels: result.pixels.len(),
            });
        }
        // A cancelled session cannot publish or reuse partially advanced source clocks.
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        let first = case.samples.first().ok_or("sample absent")?;
        assert!(
            session
                .acquire(&first.frame, &case.context, decode, &cancelled)
                .is_err()
        );
        assert!(
            session
                .acquire(&first.frame, &case.context, decode, &token)
                .is_err()
        );
    }
    if let Ok(path) = std::env::var("ASTER_NATIVE_PROJECT_FILE_REPORT") {
        fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    Ok(())
}
