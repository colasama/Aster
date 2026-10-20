use aster_eval::{EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject};
use aster_media_native::{NativeProjectMediaSession, ProjectMediaLimits, ProjectMediaTools};
use aster_project::{
    MediaSourceLimits, MediaSourceReader, ProjectMediaCatalog, ProjectMediaCatalogLimits,
    RuntimeProjectDocument, RuntimeProjectLimits,
};
use aster_render_ir::{MediaKind, ResourceDescriptor, ResourceMessage};
use aster_video::CancellationToken;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: ProjectMediaLimits,
}
#[derive(Deserialize)]
struct Proof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    cases: Vec<Case>,
    ffmpeg: Proof,
    ffprobe: Proof,
    sources: Vec<Proof>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: Proof,
    composition: String,
    scope: String,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    index: usize,
    time: f64,
    resources: Proof,
}
#[derive(Serialize)]
struct Observation {
    case: String,
    index: usize,
    source: String,
    instance: String,
    frame: String,
    matched: bool,
    rgba_sha256: Option<String>,
    expected: Vec<aster_render_ir::MediaFrameDescriptor>,
    actual: ResourceDescriptor,
}
#[derive(Serialize)]
struct Report {
    scope: &'static str,
    decoded_pixels: bool,
    observations: Vec<Observation>,
}

#[test]
#[ignore = "requires authenticated published TS plan media references"]
fn native_project_media_matches_published_descriptors() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_PROJECT_MEDIA_FRAMES")?)?)?;
    for proof in input.sources.iter().chain([&input.ffmpeg, &input.ffprobe]) {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(&proof.path))?)),
            proof.sha256
        );
    }
    let token = CancellationToken::default();
    let decoded_pixels = std::env::var("ASTER_PROJECT_MEDIA_PLAN_ONLY").as_deref() != Ok("1");
    let mut report = Report {
        scope: "diagnostic-native-root-file-media-descriptors",
        decoded_pixels,
        observations: Vec::new(),
    };
    for case in input.cases {
        let file = root.join(&case.project.path);
        let raw = fs::read(&file)?;
        assert_eq!(format!("{:x}", Sha256::digest(&raw)), case.project.sha256);
        let runtime =
            RuntimeProjectDocument::from_slice(&raw, &RuntimeProjectLimits::default())?.encode()?;
        let catalog =
            ProjectMediaCatalog::from_slice(&runtime, &ProjectMediaCatalogLimits::default())?;
        let scene = SceneProject::compile_document(
            &runtime,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let mut ids = BTreeSet::new();
        for sample in &case.samples {
            for entry in scene.evaluate(&case.composition, sample.time)? {
                let layer = scene.layer(&entry.source_composition_id, &entry.layer_id)?;
                if let Some(id) = layer.source_id.value() {
                    let binding = catalog.bind(id)?;
                    if matches!(
                        binding.source.kind.as_str(),
                        "still" | "video" | "imageSequence"
                    ) {
                        ids.insert(id.clone());
                    }
                }
            }
        }
        if ids.is_empty() {
            continue;
        }
        let bindings = ids
            .iter()
            .map(|id| catalog.bind(id))
            .collect::<Result<Vec<_>, _>>()?;
        let mut reader = MediaSourceReader::new(
            file.parent().ok_or("project parent absent")?,
            MediaSourceLimits::default(),
        )?;
        let mut session = NativeProjectMediaSession::new(
            bindings,
            &mut reader,
            &case.scope,
            ProjectMediaTools {
                ffmpeg: root.join(&input.ffmpeg.path),
                ffprobe: root.join(&input.ffprobe.path),
            },
            Options::try_parse_from(["test"])?.limits,
            &token,
        )?;
        for sample in case.samples {
            let resources = fs::read(root.join(&sample.resources.path))?;
            assert_eq!(
                format!("{:x}", Sha256::digest(&resources)),
                sample.resources.sha256
            );
            let resources: Vec<ResourceMessage> = serde_json::from_slice(&resources)?;
            let mut expected = BTreeMap::new();
            for resource in resources {
                if let ResourceMessage::PutResource(resource) = resource {
                    expected.insert(resource.hash, resource.descriptor);
                }
            }
            let mut instances = BTreeSet::new();
            for entry in scene.evaluate(&case.composition, sample.time)? {
                let layer = scene.layer(&entry.source_composition_id, &entry.layer_id)?;
                let Some(id) = layer.source_id.value().filter(|id| ids.contains(*id)) else {
                    continue;
                };
                if !instances.insert(entry.resource_instance_id.clone()) {
                    continue;
                }
                let info = session.source_info(id)?;
                let duration = match info.kind {
                    MediaKind::Video => {
                        (info.duration.ok_or("video duration absent")? - 0.001).max(0.0)
                    }
                    MediaKind::Sequence => info.duration.ok_or("sequence duration absent")?,
                    _ => f64::INFINITY,
                };
                let time = scene.source_time(
                    &entry.source_composition_id,
                    &entry.layer_id,
                    entry.local_time,
                    duration,
                )?;
                let (source, frame, rgba_sha256) = if decoded_pixels {
                    let output =
                        session.decode(id, &entry.resource_instance_id, time, false, &token)?;
                    (
                        output.source,
                        output.frame,
                        Some(output.decoded.receipt.rgba_sha256),
                    )
                } else {
                    let output = session.prepare(id, &entry.resource_instance_id, time, false)?;
                    (output.source, output.frame, None)
                };
                let expected_frames = expected
                    .values()
                    .filter_map(|value| match value {
                        ResourceDescriptor::MediaFrame(value)
                            if value.source == source.request().hash =>
                        {
                            Some(value.clone())
                        }
                        _ => None,
                    })
                    .collect();
                report.observations.push(Observation {
                    case: case.id.clone(),
                    index: sample.index,
                    source: id.clone(),
                    instance: entry.resource_instance_id,
                    frame: frame.request().hash.0.clone(),
                    matched: expected.get(&frame.request().hash)
                        == Some(&frame.request().descriptor),
                    rgba_sha256,
                    expected: expected_frames,
                    actual: frame.request().descriptor.clone(),
                });
            }
        }
        aster_project::AtomicFile::write(
            &PathBuf::from(std::env::var("ASTER_PROJECT_MEDIA_FRAMES_REPORT")?),
            |file| serde_json::to_writer_pretty(file, &report).map_err(std::io::Error::other),
        )?;
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(file)?)),
            case.project.sha256
        );
    }
    assert!(!report.observations.is_empty());
    assert!(
        report.observations.iter().all(|row| row.matched),
        "native media descriptors differ; inspect the diagnostic report"
    );
    Ok(())
}
