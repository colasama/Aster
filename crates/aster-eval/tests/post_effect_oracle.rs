mod support;
use aster_eval::{
    DepthAttachments, DepthSettings, EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject,
    SurfacePostSettings,
};
use aster_render_ir::{DepthEffectMode, FrameHeaderSlice, SurfaceEffectMode};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    depth: Vec<Depth>,
    surface: Vec<Surface>,
    materials: Vec<Material>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Material {
    layer: aster_types::editor::Layer,
    environment: Option<aster_types::editor::Environment>,
    normal_ready: bool,
    environment_ready: bool,
    normal: Option<aster_render_ir::ResourceHash>,
    environment_hash: Option<aster_render_ir::ResourceHash>,
    header: FrameHeaderSlice,
    settings: aster_eval::MaterialTextureSettings,
    expected: Plan,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct Depth {
    input: DepthSource,
    header: FrameHeaderSlice,
    mode: DepthEffectMode,
    attachments: DepthAttachments,
    settings: Value,
    expected: Plan,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DepthSource {
    Settings {
        settings: Box<DepthSettings>,
    },
    #[serde(rename_all = "camelCase")]
    Camera {
        source: Input,
        composition_id: String,
        time: f64,
        tier: f64,
        render_width: f64,
    },
}
#[derive(Deserialize)]
struct Surface {
    header: FrameHeaderSlice,
    settings: SurfacePostSettings,
    mode: SurfaceEffectMode,
    expected: Plan,
}

#[test]
#[ignore = "requires independently captured TS post effect oracle"]
fn native_post_effects_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_POST_EFFECT_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for case in oracle.materials {
        let settings = aster_eval::MaterialTextureSettings::evaluate(
            &case.layer,
            case.environment.as_ref(),
            case.normal_ready,
            case.environment_ready,
        );
        assert_eq!(settings, case.settings);
        let plan = settings.plan(
            case.header,
            aster_render_ir::CompositionIdentity::Unicode(case.layer.id),
            case.normal,
            case.environment_hash,
        )?;
        assert_eq!(serde_json::to_value(plan.metadata)?, case.expected.metadata);
        assert_eq!(plan.blobs, case.expected.blobs);
    }
    for (index, case) in oracle.depth.into_iter().enumerate() {
        let settings = match case.input {
            DepthSource::Settings { settings } => *settings,
            DepthSource::Camera {
                source,
                composition_id,
                time,
                tier,
                render_width,
            } => {
                let raw = fs::read(root.join(source.path))?;
                assert_eq!(format!("{:x}", Sha256::digest(&raw)), source.sha256);
                let document: aster_types::editor::Project = serde_json::from_slice(&raw)?;
                let width = document
                    .compositions
                    .iter()
                    .find(|c| c.id == composition_id)
                    .ok_or("composition")?
                    .width
                    .as_f64()
                    .ok_or("width")?;
                let project = SceneProject::compile(
                    document,
                    &SceneLimits::default(),
                    &EvaluationLimits::default(),
                    &ExpressionLimits::default(),
                )?;
                DepthSettings::from_camera(
                    &project.camera(&composition_id, time)?.ok_or("camera")?,
                    width,
                    render_width,
                    tier,
                )
            }
        };
        Comparison::compare(
            &serde_json::to_value(&settings)?,
            &case.settings,
            &format!("depth settings {index}"),
        );
        let actual = settings.build(case.header, case.mode, &case.attachments)?;
        assert_eq!(
            serde_json::to_value(actual.metadata)?,
            case.expected.metadata,
            "depth metadata {index}"
        );
        assert_eq!(actual.blobs, case.expected.blobs, "depth bytes {index}");
    }
    for (index, case) in oracle.surface.into_iter().enumerate() {
        let actual = case.settings.build(case.header, case.mode)?;
        assert_eq!(
            serde_json::to_value(actual.metadata)?,
            case.expected.metadata,
            "surface metadata {index}"
        );
        assert_eq!(actual.blobs, case.expected.blobs, "surface bytes {index}");
    }
    Ok(())
}
