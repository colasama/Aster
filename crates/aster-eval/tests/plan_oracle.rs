mod support;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, FramePlanRequest, MotionSettings, NativePlan,
    RootResourceBindings, SceneLimits, SceneProject, TextGeometryBounds,
};
use aster_render_ir::{DecodeLimits, FplnCodec, ResourceHash};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::PathBuf,
};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    projects: Vec<Input>,
    cases: Vec<Case>,
    rates: Vec<Rate>,
    shutters: Vec<ShutterCase>,
    outputs: Vec<OutputCase>,
}
#[derive(Deserialize)]
struct OutputCase {
    header: aster_render_ir::FrameHeaderSlice,
    input: aster_eval::FrameOutputSettings,
    expected: BytePlan,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShutterCase {
    source: Option<aster_types::editor::MotionBlur>,
    time: f64,
    frame_rate: f64,
    travel: f64,
    settings: MotionSettings,
    interval: Value,
    adaptive: u32,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    project: usize,
    request: FramePlanRequest,
    text_bounds: BTreeMap<String, TextGeometryBounds>,
    bindings: Bindings,
    expected: Option<Expected>,
    error: bool,
}
#[derive(Deserialize)]
struct Expected {
    #[serde(rename = "mediaBindings")]
    media_bindings: Vec<aster_render_ir::SceneMediaBinding>,
    #[serde(rename = "sceneMedia")]
    scene_media: Plan,
    effects: Effects,
    #[serde(rename = "surfaceEffects")]
    surface_effects: Effects,
    scene: Plan,
    post: Plan,
    root: BytePlan,
    motion: MotionExpected,
}
#[derive(Deserialize)]
struct Effects {
    records: Vec<aster_render_ir::PrecompositionEffectRecord>,
    resources: Vec<EffectResource>,
}
#[derive(Deserialize)]
struct EffectResource {
    message: aster_render_ir::ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}
impl Effects {
    fn compare(&self, effects: Vec<aster_eval::BundleEffect>) -> Result<(), Box<dyn Error>> {
        let mut resources = aster_eval::BundleResources::new(aster_eval::BundleLimits::default())?;
        let actual = effects
            .into_iter()
            .map(|e| e.prepared.record(e.instance_id, &mut resources))
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(actual, self.records, "project effect records");
        let resources = resources.finish();
        assert_eq!(resources.len(), self.resources.len());
        for (a, b) in resources.iter().zip(&self.resources) {
            assert_eq!(
                aster_render_ir::ResourceMessage::PutResource(a.request().clone()),
                b.message
            );
            assert_eq!(a.bytes().len(), b.byte_length);
            assert_eq!(format!("{:x}", Sha256::digest(a.bytes())), b.payload_sha256);
        }
        Ok(())
    }
}
#[derive(Deserialize)]
struct MotionExpected {
    scene: Plan,
    settings: MotionSettings,
    interval: Value,
    enabled: BTreeSet<String>,
    vectors: Vec<f32>,
    plan: BytePlan,
}
#[derive(Deserialize)]
struct Bindings {
    material_resources: aster_eval::MaterialResources,
    media: BTreeMap<String, Option<ResourceHash>>,
    generators: BTreeSet<String>,
}
#[derive(Deserialize)]
struct BytePlan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    floats: Vec<f32>,
}
#[derive(Deserialize)]
struct Rate {
    numerator: f64,
    denominator: f64,
    expected: Value,
}

impl Input {
    fn read(&self, root: &std::path::Path) -> Result<Vec<u8>, Box<dyn Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            self.sha256,
            "source {}",
            self.path
        );
        Ok(bytes)
    }
}
impl Plan {
    fn compare(&self, plan: &NativePlan, context: &str) -> Result<(), Box<dyn Error>> {
        assert_eq!(
            serde_json::to_value(&plan.metadata)?,
            self.metadata,
            "metadata {context}"
        );
        let floats: Vec<_> = plan.blobs[0]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        Comparison::compare(
            &serde_json::to_value(floats)?,
            &serde_json::to_value(&self.floats)?,
            context,
        );
        let bytes = plan.encode(&DecodeLimits::default())?;
        let decoded = FplnCodec::decode(bytes, &DecodeLimits::default())?;
        assert_eq!(decoded.metadata, plan.metadata);
        assert_eq!(decoded.blob(0)?, plan.blobs[0]);
        Ok(())
    }
}

#[test]
#[ignore = "requires independently captured TS plan producer oracle"]
fn native_plan_producers_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_PLAN_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.projects.len() >= 336 && oracle.cases.len() >= 672);
    for source in oracle.sources {
        source.read(&root)?;
    }
    for rate in oracle.rates {
        assert_eq!(
            serde_json::to_value(FramePlanRequest::frame_rate(
                rate.numerator,
                rate.denominator
            )?)?,
            rate.expected
        );
    }
    for case in oracle.shutters {
        let settings = MotionSettings::normalize(case.source.as_ref());
        assert_eq!(settings, case.settings);
        let count = settings.adaptive_samples(case.travel);
        assert_eq!(count, case.adaptive);
        Comparison::compare(
            &serde_json::to_value(settings.interval(case.time, case.frame_rate, Some(count)))?,
            &case.interval,
            "shutter boundary",
        );
    }
    for case in oracle.outputs {
        let plan = case.input.build(case.header)?;
        assert_eq!(serde_json::to_value(plan.metadata)?, case.expected.metadata);
        assert_eq!(plan.blobs, case.expected.blobs);
    }
    for (index, input) in oracle.projects.iter().enumerate() {
        let project: aster_types::editor::Project = serde_json::from_slice(&input.read(&root)?)?;
        let scene = SceneProject::compile(
            project.clone(),
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for case in oracle.cases.iter().rev().filter(|c| c.project == index) {
            let plans = scene.plan_scene_frame(&case.request, &case.text_bounds);
            assert_eq!(
                plans.is_err(),
                case.error,
                "project {index} at {}: {:?}",
                case.request.time,
                plans.as_ref().err()
            );
            if case.error {
                continue;
            }
            let plans = plans?;
            let material_layers =
                scene.evaluate(&case.request.composition_id, case.request.time)?;
            let materials = scene.plan_materials(
                plans.scene.metadata.header.clone(),
                &material_layers,
                &case.bindings.material_resources,
            )?;
            let root = scene.plan_root_scene(
                &case.request,
                &plans,
                &RootResourceBindings {
                    media: case.bindings.media.clone(),
                    generators: case.bindings.generators.clone(),
                    materials,
                    surfaces: BTreeMap::new(),
                },
            )?;
            let expected = case.expected.as_ref().expect("successful producer plans");
            let composition = project
                .composition(&case.request.composition_id)
                .ok_or("missing composition")?;
            let layers = scene.evaluate(&case.request.composition_id, case.request.time)?;
            expected.effects.compare(scene.plan_effects(
                plans.scene.metadata.header.clone(),
                &layers,
                aster_eval::EffectContext::Root,
                4,
            )?)?;
            expected.surface_effects.compare(scene.plan_effects(
                plans.scene.metadata.header.clone(),
                &layers,
                aster_eval::EffectContext::Precomposition,
                4,
            )?)?;
            let settings = MotionSettings::normalize(composition.motion_blur.value());
            let rate = composition.frame_rate.numerator.as_f64().ok_or("rate")?
                / composition.frame_rate.denominator.as_f64().ok_or("rate")?;
            let interval = settings.interval(case.request.time, rate, None);
            assert_eq!(settings, expected.motion.settings);
            Comparison::compare(
                &serde_json::to_value(&interval)?,
                &expected.motion.interval,
                "shutter interval",
            );
            let current = scene.geometry_at(
                &case.request.composition_id,
                case.request.time,
                &case.text_bounds,
            )?;
            let enabled = scene.motion_selection_ids(
                &case.request.composition_id,
                case.request.time,
                &current,
            )?;
            assert_eq!(enabled, expected.motion.enabled);
            for visualization in [
                aster_eval::BufferVisualization::MotionVector,
                aster_eval::BufferVisualization::VectorMotionBlur,
                aster_eval::BufferVisualization::Normal,
            ] {
                let frame = scene.prepare_frame_scene(
                    &case.request,
                    &aster_eval::FrameSceneInputs {
                        visualization,
                        text_bounds: case.text_bounds.clone(),
                        motion_text_bounds: case.text_bounds.clone(),
                        text_layouts: BTreeMap::new(),
                        locale: "en-US".into(),
                    },
                )?;
                let requested = settings.enabled
                    && settings.shutter_angle > 0.0
                    && !enabled.is_empty()
                    && !matches!(visualization, aster_eval::BufferVisualization::Normal);
                assert_eq!(frame.motion_blur_requested, requested);
                assert!(!frame.beauty_motion_blur && !frame.beauty_depth_of_field);
                assert_eq!(frame.motion_selection_ids, enabled);
                assert_eq!(frame.geometry.data, current.data);
                if requested {
                    expected
                        .motion
                        .scene
                        .compare(&frame.plans.scene, "prepared motion frame")?;
                } else {
                    expected
                        .scene
                        .compare(&frame.plans.scene, "prepared static frame")?;
                }
            }
            let open = scene.geometry_at(
                &case.request.composition_id,
                interval.open_time,
                &case.text_bounds,
            )?;
            let close = scene.geometry_at(
                &case.request.composition_id,
                interval.close_time,
                &case.text_bounds,
            )?;
            let vectors = current.motion_vectors(&open, &close, Some(&enabled))?;
            Comparison::compare(
                &serde_json::to_value(&vectors)?,
                &serde_json::to_value(&expected.motion.vectors)?,
                "motion vectors",
            );
            expected.motion.scene.compare(
                &plans.clone().with_motion(&vectors)?.scene,
                "scene with motion",
            )?;
            let bound = plans
                .clone()
                .with_motion(&vectors)?
                .with_media(expected.media_bindings.clone())?;
            expected
                .scene_media
                .compare(&bound.scene, "scene media bindings")?;
            if !expected.media_bindings.is_empty() {
                assert!(bound.with_media(expected.media_bindings.clone()).is_err());
            }
            let motion = settings.reconstruction(
                plans.scene.metadata.header.clone(),
                &interval,
                settings.enabled,
                case.request.time == 0.125,
                composition.width.as_f64().ok_or("width")?,
            )?;
            assert_eq!(
                serde_json::to_value(&motion.metadata)?,
                expected.motion.plan.metadata
            );
            assert_eq!(motion.blobs, expected.motion.plan.blobs);
            assert_eq!(
                serde_json::to_value(&root.metadata)?,
                expected.root.metadata,
                "root metadata {index}"
            );
            assert_eq!(root.blobs, expected.root.blobs, "root bytes {index}");
            expected
                .scene
                .compare(&plans.scene, &format!("scene {index}"))?;
            expected
                .post
                .compare(&plans.post, &format!("post {index}"))?;
        }
    }
    Ok(())
}
