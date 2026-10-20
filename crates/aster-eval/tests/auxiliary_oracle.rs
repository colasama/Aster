use aster_eval::{
    AuxiliaryBudget, EvaluationLimits, ExpressionLimits, FramePlanRequest, RootResourceBindings,
    SceneLimits, SceneProject,
};
use aster_render_ir::{AuxiliaryStatus, DecodeLimits, FplnCodec, ResourceHash};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct Input {
    path: Option<String>,
    document: Option<String>,
    sha256: String,
}
#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    projects: Vec<Input>,
    cases: Vec<Case>,
    budgets: Vec<BudgetCase>,
}
#[derive(Deserialize)]
struct BudgetCase {
    draws: usize,
    vertices: u32,
    budget: AuxiliaryBudget,
    expected: AuxiliaryStatus,
}
#[derive(Deserialize)]
struct Case {
    project: usize,
    request: FramePlanRequest,
    media: BTreeMap<String, Option<ResourceHash>>,
    surfaces: BTreeMap<String, String>,
    generators: Vec<String>,
    variants: Vec<Variant>,
}
#[derive(Deserialize)]
struct Variant {
    budget: AuxiliaryBudget,
    motion: Option<Vec<f32>>,
    expected: Plan,
    outputs: Vec<OutputCase>,
}
#[derive(Deserialize)]
struct OutputCase {
    context: aster_eval::FrameOutputContext,
    expected: BTreeMap<String, Option<Plan>>,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
impl Input {
    fn read(&self, root: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
        let bytes = match (&self.path, &self.document) {
            (Some(path), None) => fs::read(root.join(path))?,
            (None, Some(document)) => document.as_bytes().to_vec(),
            _ => return Err("ambiguous oracle input".into()),
        };
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), self.sha256);
        Ok(bytes)
    }
}
#[test]
#[ignore = "requires authenticated TS auxiliary producer oracle"]
fn native_auxiliary_matches_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_AUXILIARY_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.projects.len() >= 348 && oracle.cases.len() >= 348);
    assert_eq!(oracle.budgets.len(), 240);
    for source in &oracle.sources {
        source.read(&root)?;
    }
    for case in &oracle.budgets {
        assert_eq!(
            case.budget.outcome(case.draws, case.vertices)?,
            case.expected
        );
    }
    for (index, input) in oracle.projects.iter().enumerate() {
        let scene = SceneProject::compile_document(
            &input.read(&root)?,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for case in oracle.cases.iter().rev().filter(|c| c.project == index) {
            let layers = scene.evaluate(&case.request.composition_id, case.request.time)?;
            let plans = scene.plan_scene_frame(&case.request, &BTreeMap::new())?;
            let bindings = RootResourceBindings {
                media: case.media.clone(),
                surfaces: case.surfaces.clone(),
                ..Default::default()
            };
            for (variant, input) in case.variants.iter().enumerate().rev() {
                let source = match &input.motion {
                    Some(vectors) => plans.clone().with_motion(vectors)?,
                    None => plans.clone(),
                };
                let plan = scene.plan_auxiliary(
                    &source,
                    &layers,
                    &bindings,
                    &input.budget,
                    &case.generators,
                )?;
                assert_eq!(
                    serde_json::to_value(&plan.metadata)?,
                    input.expected.metadata,
                    "metadata project {index} variant {variant}"
                );
                assert_eq!(
                    plan.blobs, input.expected.blobs,
                    "bytes project {index} variant {variant}"
                );
                let decoded = FplnCodec::decode(
                    plan.encode(&DecodeLimits::default())?,
                    &DecodeLimits::default(),
                )?;
                assert_eq!(decoded.metadata, plan.metadata);
                assert_eq!(decoded.blob(0)?, plan.blobs[0]);
                for (output_index, output) in input.outputs.iter().enumerate() {
                    let plans =
                        scene.plan_frame_output(&source, &layers, &bindings, &output.context)?;
                    for (name, actual) in [
                        ("auxiliary", plans.auxiliary),
                        ("motion", Some(plans.motion)),
                        ("output", Some(plans.output)),
                        ("effect", plans.effect),
                    ] {
                        let expected = output.expected.get(name).ok_or("output stage absent")?;
                        assert_eq!(
                            actual.is_some(),
                            expected.is_some(),
                            "output presence {index}/{variant}/{output_index}/{name}"
                        );
                        if let (Some(actual), Some(expected)) = (actual, expected) {
                            assert_eq!(
                                serde_json::to_value(actual.metadata)?,
                                expected.metadata,
                                "output metadata {index}/{variant}/{output_index}/{name}"
                            );
                            assert_eq!(
                                actual.blobs, expected.blobs,
                                "output bytes {index}/{variant}/{output_index}/{name}"
                            );
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
