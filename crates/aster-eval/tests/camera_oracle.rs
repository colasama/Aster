mod support;

use aster_eval::{CameraProjector, CameraTrack, EvaluatedTransform, EvaluationLimits};
use aster_types::editor::Camera;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    camera: Option<Camera>,
    size: [f64; 2],
    points: Vec<[f64; 3]>,
    default_camera: bool,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    transform: EvaluatedTransform,
    evaluated: Value,
    basis: Value,
    projected: Value,
    depth_samples: Vec<DepthSample>,
    sample_count: u32,
}
#[derive(Deserialize)]
struct DepthSample {
    camera_depth: f64,
    surface_depth: f64,
    render_width: f64,
    value: f64,
}

#[test]
#[ignore = "requires independently captured current-source TS camera oracle"]
fn native_camera_matches_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_CAMERA_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 14);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (index, case) in oracle.cases.into_iter().enumerate() {
        let camera = CameraTrack::compile(
            case.camera.as_ref(),
            case.size,
            &EvaluationLimits::default(),
        )?;
        for sample in case.samples.iter().rev() {
            let evaluated = if case.default_camera {
                CameraTrack::default_evaluated(case.size, &EvaluationLimits::default())?
            } else {
                camera.evaluate(&sample.transform, sample.time, case.size[0])?
            };
            Comparison::compare(
                &serde_json::to_value(&evaluated)?,
                &sample.evaluated,
                &format!("camera {index} at {}", sample.time),
            );
            Comparison::compare(
                &serde_json::to_value(evaluated.pose.basis())?,
                &sample.basis,
                "camera basis",
            );
            let projector = CameraProjector::new(&evaluated.pose, &evaluated.projection, case.size);
            let points: Vec<_> = case
                .points
                .iter()
                .map(|point| projector.project(*point))
                .collect();
            Comparison::compare(
                &serde_json::to_value(points)?,
                &sample.projected,
                &format!("camera {index} projection"),
            );
            for depth in &sample.depth_samples {
                Comparison::compare(
                    &serde_json::to_value(evaluated.optics.circle_of_confusion(
                        depth.camera_depth,
                        depth.surface_depth,
                        case.size[0],
                        depth.render_width,
                    ))?,
                    &serde_json::to_value(depth.value)?,
                    "circle of confusion",
                );
            }
            assert_eq!(evaluated.optics.sample_count(), sample.sample_count);
        }
    }
    Ok(())
}
