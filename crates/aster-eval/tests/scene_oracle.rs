mod support;
use aster_eval::{
    CameraProjector, CameraTrack, EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    cases: Vec<Input>,
}

#[derive(Deserialize)]
struct Input {
    path: PathBuf,
    sha256: String,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    project: Input,
    composition_id: String,
    duration: f64,
    samples: Vec<Sample>,
    size: [f64; 2],
}

#[derive(Deserialize)]
struct Sample {
    time: f64,
    visible: Vec<String>,
    world: Vec<World>,
    camera: Value,
    resources: Option<Resources>,
    #[serde(default)]
    deferred_cloner: bool,
    #[serde(default)]
    error: bool,
    layers: Option<Value>,
}

#[derive(Deserialize)]
struct World {
    layer_id: String,
    transform: Value,
    source_time: f64,
}

#[derive(Deserialize)]
struct Resources {
    lighting: Value,
    geometry: Value,
    text_bounds: std::collections::BTreeMap<String, aster_eval::TextGeometryBounds>,
}

impl Input {
    fn read(&self, root: &std::path::Path) -> Result<Vec<u8>, Box<dyn Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            self.sha256,
            "Input changed: {}",
            self.path.display()
        );
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires independently captured current-source TS scene oracles"]
fn native_scene_components_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_SCENE_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 346);
    assert!(oracle.sources.len() >= 9);
    for source in &oracle.sources {
        source.read(&root)?;
    }
    for input in &oracle.cases {
        let case: Case = serde_json::from_slice(&input.read(&root)?)?;
        let scene = SceneProject::compile(
            serde_json::from_slice(&case.project.read(&root)?)?,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples.iter().rev() {
            Comparison::compare(
                &serde_json::to_value(scene.camera(&case.composition_id, sample.time)?)?,
                &sample.camera,
                &format!("{} selected camera at {}", case.id, sample.time),
            );
            assert_eq!(
                scene.visible_layer_ids(&case.composition_id, sample.time)?,
                sample.visible,
                "{} visibility",
                case.id
            );
            for world in &sample.world {
                Comparison::compare(
                    &serde_json::to_value(scene.world_transform(
                        &case.composition_id,
                        &world.layer_id,
                        sample.time,
                    )?)?,
                    &world.transform,
                    &format!("{} world {}", case.id, world.layer_id),
                );
                Comparison::compare(
                    &serde_json::to_value(scene.source_time(
                        &case.composition_id,
                        &world.layer_id,
                        sample.time,
                        case.duration,
                    )?)?,
                    &serde_json::to_value(world.source_time)?,
                    "source clock",
                );
            }
            if !sample.deferred_cloner {
                let actual = scene.evaluate(&case.composition_id, sample.time);
                assert_eq!(
                    actual.is_err(),
                    sample.error,
                    "{} scene at {}: {:?}",
                    case.id,
                    sample.time,
                    actual.as_ref().err()
                );
                if !sample.error {
                    let actual = actual?;
                    if let Some(resources) = &sample.resources {
                        let camera = scene.camera(&case.composition_id, sample.time)?;
                        let lighting = scene.lighting(
                            &case.composition_id,
                            &actual,
                            true,
                            camera.as_ref().map(|c| c.pose.position),
                        )?;
                        Comparison::compare(
                            &serde_json::to_value(lighting.data.as_slice())?,
                            &resources.lighting,
                            "scene lighting",
                        );
                        let camera = match camera {
                            Some(camera) => camera,
                            None => CameraTrack::default_evaluated(
                                case.size,
                                &EvaluationLimits::default(),
                            )?,
                        };
                        let projector =
                            CameraProjector::new(&camera.pose, &camera.projection, case.size);
                        let geometry = serde_json::to_value(scene.geometry(
                            &case.composition_id,
                            &actual,
                            &projector,
                            &resources.text_bounds,
                        )?)?;
                        assert_eq!(
                            geometry["batches"], resources.geometry["batches"],
                            "draw identities and vertex ranges"
                        );
                        Comparison::compare(
                            &geometry["data"],
                            &resources.geometry["data"],
                            &format!("{} geometry at {}", case.id, sample.time),
                        );
                    }
                    Comparison::compare(
                        &serde_json::to_value(actual)?,
                        sample.layers.as_ref().ok_or("missing expected scene")?,
                        &format!("{} scene at {}", case.id, sample.time),
                    );
                }
            }
        }
    }
    Ok(())
}
