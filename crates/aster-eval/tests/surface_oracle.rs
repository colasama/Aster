mod support;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, RootResourceBindings, SceneLimits, SceneProject,
    SurfaceLimits, SurfaceRequest, TextLayouts,
};
use aster_render_ir::{FrameHeaderSlice, ResourceHash};
use aster_types::editor::Project;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;
#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    cases: Vec<Case>,
    #[serde(rename = "generatorDefinition")]
    generator_definition: aster_eval::GeneratorDefinition,
    #[serde(rename = "generatorSource")]
    generator_source: aster_eval::GeneratorProgramSource,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    project: ProjectInput,
    composition_id: String,
    samples: Vec<Sample>,
    layouts: Option<TextLayouts>,
    locale: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum ProjectInput {
    Source(Input),
    Document(Project),
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    request: SurfaceRequest,
    expected: Option<Value>,
    error: bool,
    frame: Option<FrameCase>,
}
#[derive(Deserialize)]
struct FrameCase {
    #[serde(rename = "generatorDevice")]
    generator_device: aster_eval::GeneratorDeviceLimits,
    header: FrameHeaderSlice,
    media: BTreeMap<String, Option<ResourceHash>>,
    expected: Frames,
}
#[derive(Deserialize)]
struct Frames {
    graph: BytePlan,
    frames: Vec<Frame>,
}
#[derive(Deserialize)]
struct Frame {
    programs: Programs,
    target: Value,
    scene: FloatPlan,
    root: BytePlan,
    draw_scene_indices: Vec<u32>,
}
#[derive(Deserialize)]
struct Programs {
    label_utf16: Vec<u16>,
    scene: FloatPlan,
    effects: Vec<aster_render_ir::PrecompositionEffectRecord>,
    resources: Vec<ResourceProof>,
    generators: Vec<GeneratorProof>,
}
#[derive(Deserialize)]
struct ResourceProof {
    message: aster_render_ir::ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}
impl ResourceProof {
    fn compare(&self, actual: &aster_render_ir::VerifiedResource) {
        assert_eq!(
            aster_render_ir::ResourceMessage::PutResource(actual.request().clone()),
            self.message
        );
        assert_eq!(actual.bytes().len(), self.byte_length);
        assert_eq!(
            format!("{:x}", Sha256::digest(actual.bytes())),
            self.payload_sha256
        );
    }
}
#[derive(Deserialize)]
struct GeneratorProof {
    plan: BytePlan,
    resources: Vec<ResourceProof>,
    origin: Origin,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Origin {
    layer_name: String,
    plugin_id: String,
}
#[derive(Deserialize)]
struct BytePlan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct FloatPlan {
    metadata: Value,
    floats: Vec<f32>,
}
#[test]
#[ignore = "requires independently captured TS precomposition oracle"]
fn native_precomposition_sources_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_SURFACE_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    let catalog = aster_eval::GeneratorCatalog::compile(
        vec![(oracle.generator_definition, oracle.generator_source)],
        aster_plugin::generator::GeneratorLimits::default(),
        aster_eval::BundleLimits::default(),
    )?;
    assert!(oracle.cases.len() >= 5);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (index, case) in oracle.cases.into_iter().enumerate() {
        let mut document = match case.project {
            ProjectInput::Document(project) => project,
            ProjectInput::Source(input) => {
                let bytes = fs::read(root.join(input.path))?;
                assert_eq!(format!("{:x}", Sha256::digest(&bytes)), input.sha256);
                serde_json::from_slice(&bytes)?
            }
        };
        // JSON numeric spellings such as 32 and 32.0 have identical editor semantics.
        for composition in &mut document.compositions {
            if let Some(width) = composition
                .width
                .as_f64()
                .and_then(serde_json::Number::from_f64)
            {
                composition.width = width;
            }
            if let Some(height) = composition
                .height
                .as_f64()
                .and_then(serde_json::Number::from_f64)
            {
                composition.height = height;
            }
        }
        let project = SceneProject::compile(
            document,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples.into_iter().rev() {
            let result = project
                .evaluate(&case.composition_id, sample.time)
                .and_then(|scene| match &case.layouts {
                    Some(layouts) => project.precomposition_sources_with_text(
                        &scene,
                        sample.request,
                        &SurfaceLimits::default(),
                        layouts,
                        case.locale.as_deref().ok_or_else(|| {
                            aster_eval::EvaluationError::InvalidScene("missing locale".into())
                        })?,
                    ),
                    None => project.precomposition_sources(
                        &scene,
                        sample.request,
                        &SurfaceLimits::default(),
                    ),
                });
            assert_eq!(
                result.is_err(),
                sample.error,
                "case {index}: {:?}",
                result.as_ref().err()
            );
            if sample.error {
                continue;
            }
            let result = result?;
            if let Some(frame) = sample.frame {
                let bindings = RootResourceBindings {
                    media: frame.media.clone(),
                    generators: frame
                        .expected
                        .frames
                        .iter()
                        .flat_map(|f| &f.programs.generators)
                        .map(|g| {
                            let id = &g.plan.metadata["slices"][0]["instance_id"];
                            let typed: aster_render_ir::CompositionIdentity =
                                serde_json::from_value(id.clone()).expect("generator identity");
                            let aster_render_ir::CompositionIdentity::Unicode(id) = typed else {
                                panic!("project generator identity")
                            };
                            id
                        })
                        .collect(),
                    ..RootResourceBindings::default()
                };
                let assembled = project.plan_surface_programs(
                    frame.header.clone(),
                    &result,
                    &aster_eval::SurfaceProgramInputs {
                        bindings: bindings.clone(),
                        text_bounds: BTreeMap::new(),
                        generator_device: frame.generator_device,
                        audio: None,
                    },
                    &catalog,
                )?;
                assert_eq!(assembled.scenes.len(), frame.expected.frames.len());
                for (actual, expected) in assembled.scenes.into_iter().zip(&frame.expected.frames) {
                    let expected = &expected.programs;
                    assert_eq!(actual.label_utf16, expected.label_utf16);
                    assert_eq!(
                        serde_json::to_value(&actual.scene.metadata)?,
                        expected.scene.metadata
                    );
                    let floats: Vec<_> = actual.scene.blobs[0]
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    Comparison::compare(
                        &serde_json::to_value(floats)?,
                        &serde_json::to_value(&expected.scene.floats)?,
                        "bound surface scene",
                    );
                    let mut resources =
                        aster_eval::BundleResources::new(aster_eval::BundleLimits::default())?;
                    let records = actual
                        .effects
                        .into_iter()
                        .map(|e| e.prepared.record(e.instance_id, &mut resources))
                        .collect::<Result<Vec<_>, _>>()?;
                    assert_eq!(records, expected.effects);
                    let resources = resources.finish();
                    assert_eq!(resources.len(), expected.resources.len());
                    for (a, b) in resources.iter().zip(&expected.resources) {
                        b.compare(a);
                    }
                    assert_eq!(actual.generators.len(), expected.generators.len());
                    for (a, b) in actual.generators.iter().zip(&expected.generators) {
                        assert_eq!(serde_json::to_value(&a.plan.metadata)?, b.plan.metadata);
                        assert_eq!(a.plan.blobs, b.plan.blobs);
                        assert_eq!(
                            a.layer_name_utf16,
                            b.origin.layer_name.encode_utf16().collect::<Vec<_>>()
                        );
                        assert_eq!(
                            a.plugin_id_utf16,
                            b.origin.plugin_id.encode_utf16().collect::<Vec<_>>()
                        );
                        assert_eq!(a.shaders.len(), b.resources.len());
                        for (a, b) in a.shaders.iter().zip(&b.resources) {
                            b.compare(a);
                        }
                    }
                }
                let plans = project.plan_surface_frames(
                    frame.header,
                    &result,
                    &BTreeMap::new(),
                    &bindings,
                )?;
                assert_eq!(
                    serde_json::to_value(&plans.graph.metadata)?,
                    frame.expected.graph.metadata,
                    "graph metadata {index}"
                );
                assert_eq!(
                    plans.graph.blobs, frame.expected.graph.blobs,
                    "graph bytes {index}"
                );
                assert_eq!(plans.frames.len(), frame.expected.frames.len());
                for (actual, expected) in plans.frames.iter().zip(&frame.expected.frames) {
                    assert_eq!(serde_json::to_value(&actual.target)?, expected.target);
                    assert_eq!(
                        serde_json::to_value(&actual.scene.scene.metadata)?,
                        expected.scene.metadata
                    );
                    let floats: Vec<_> = actual.scene.scene.blobs[0]
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    Comparison::compare(
                        &serde_json::to_value(floats)?,
                        &serde_json::to_value(&expected.scene.floats)?,
                        "surface scene",
                    );
                    assert_eq!(
                        serde_json::to_value(&actual.root.metadata)?,
                        expected.root.metadata,
                        "surface root {index}"
                    );
                    assert_eq!(actual.root.blobs, expected.root.blobs);
                    assert_eq!(actual.draw_scene_indices, expected.draw_scene_indices);
                }
            }
            let actual = serde_json::to_value(result)?;
            let expected = sample.expected.as_ref().ok_or("missing surface expected")?;
            for key in ["budget", "bindings", "activeKeys", "diagnostics"] {
                assert_eq!(actual[key], expected[key], "surface {index} {key}");
            }
            for (actual, expected) in actual["operations"]
                .as_array()
                .ok_or("operations")?
                .iter()
                .zip(expected["operations"].as_array().ok_or("operations")?)
            {
                assert_eq!(actual["target"], expected["target"]);
                assert_eq!(actual["source"]["target"], expected["source"]["target"]);
            }
            Comparison::compare(&actual, expected, &format!("surface {index}"));
        }
    }
    Ok(())
}
