use aster_eval::{
    EvaluationLimits, GeneratorContext, GeneratorDefinition, GeneratorDeviceLimits,
    GeneratorInvocation, GeneratorProgramSource, LayerClock, NativeGeneratorProgram,
};
use aster_plugin::generator::GeneratorLimits;
use aster_types::editor::{Generator, Layer};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
    #[serde(rename = "programSource")]
    program_source: GeneratorProgramSource,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    project: aster_types::editor::Project,
    header: aster_render_ir::FrameHeaderSlice,
    invocation: GeneratorInvocation,
    audio: Option<Vec<u32>>,
    plan: Plan,
    #[serde(rename = "programResources")]
    program_resources: Vec<ResourceExpectation>,
    definition: GeneratorDefinition,
    instance: Generator,
    layer: Layer,
    time: f64,
    context: GeneratorContext,
    device: GeneratorDeviceLimits,
    expected: Value,
}

#[derive(Deserialize)]
struct Plan {
    metadata: aster_render_ir::FramePlanSliceV1,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct ResourceExpectation {
    message: aster_render_ir::ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}

#[test]
#[ignore = "requires independently captured TS generator oracle"]
fn native_generators_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_GENERATOR_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 40);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    let limits = GeneratorLimits::default();
    for (index, case) in oracle.cases.iter().enumerate().rev() {
        let clock = LayerClock::compile(&case.layer, &EvaluationLimits::default())?;
        let time = clock.evaluate(case.time, f64::INFINITY)?;
        assert!(
            (time - case.context.source_time).abs() < 1e-8,
            "source time {index}"
        );
        let inputs =
            case.definition
                .prepare(&case.instance, &case.context, &case.device, &limits)?;
        let program =
            NativeGeneratorProgram::compile(&case.definition, &oracle.program_source, &limits)?;
        let plan = inputs.plan(
            case.header.clone(),
            case.invocation.clone(),
            &program,
            case.audio.as_deref(),
        )?;
        assert_eq!(plan.metadata, case.plan.metadata, "generator plan {index}");
        assert_eq!(plan.blobs, case.plan.blobs, "generator bytes {index}");
        assert_eq!(program.shaders.len(), case.program_resources.len());
        for (actual, expected) in program.shaders.iter().zip(&case.program_resources) {
            assert_eq!(
                aster_render_ir::ResourceMessage::PutResource(actual.request().clone()),
                expected.message
            );
            assert_eq!(actual.bytes().len(), expected.byte_length);
            assert_eq!(
                format!("{:x}", Sha256::digest(actual.bytes())),
                expected.payload_sha256
            );
        }
        let catalog = aster_eval::GeneratorCatalog::compile(
            vec![(case.definition.clone(), oracle.program_source.clone())],
            limits.clone(),
            aster_eval::BundleLimits::default(),
        )?;
        let project = aster_eval::SceneProject::compile(
            case.project.clone(),
            &aster_eval::SceneLimits::default(),
            &EvaluationLimits::default(),
            &aster_eval::ExpressionLimits::default(),
        )?;
        let aster_render_ir::CompositionIdentity::Unicode(composition_id) =
            &case.header.composition_id
        else {
            return Err("composition identity".into());
        };
        let scenes = project.evaluate(composition_id, case.time)?;
        let selected = scenes
            .into_iter()
            .filter(|s| {
                aster_render_ir::CompositionIdentity::Unicode(s.instance_id.clone())
                    == case.invocation.instance_id
            })
            .collect::<Vec<_>>();
        assert_eq!(selected.len(), 1);
        let settings = aster_eval::GeneratorFrameSettings {
            device: case.device.clone(),
            camera: case.context.camera.clone(),
            audio: case.audio.clone(),
        };
        let mut driven =
            project.plan_generators(case.header.clone(), &selected, &catalog, &settings)?;
        assert_eq!(driven.len(), 1);
        assert_eq!(
            driven[0].plan.metadata, case.plan.metadata,
            "project generator {index}"
        );
        assert_eq!(
            driven[0].plan.blobs, case.plan.blobs,
            "project generator payload {index}"
        );
        use aster_render_ir::PrecompositionGeneratorExecution as Execution;
        assert!(driven[0].observe_execution(Execution::Planned).is_err());
        assert!(
            driven[0]
                .observe_execution(Execution::Ready {
                    capacity: inputs.capacity.saturating_add(1),
                    effective_count: inputs.effective_count
                })
                .is_err()
        );
        assert!(!driven[0].observe_execution(Execution::Unavailable)?);
        assert!(driven[0].observe_execution(Execution::Ready {
            capacity: inputs.capacity,
            effective_count: inputs.effective_count
        })?);
        if index == 0 {
            let empty = aster_eval::GeneratorCatalog::compile(
                Vec::new(),
                limits.clone(),
                aster_eval::BundleLimits::default(),
            )?;
            assert!(
                project
                    .plan_generators(case.header.clone(), &selected, &empty, &settings)
                    .is_err()
            );
            assert!(
                aster_eval::GeneratorCatalog::compile(
                    vec![(case.definition.clone(), oracle.program_source.clone()); 2],
                    limits.clone(),
                    aster_eval::BundleLimits::default()
                )
                .is_err()
            );
            assert!(
                aster_eval::GeneratorCatalog::compile(
                    vec![(case.definition.clone(), oracle.program_source.clone())],
                    limits.clone(),
                    aster_eval::BundleLimits {
                        max_bundle_bytes: 1,
                        ..aster_eval::BundleLimits::default()
                    }
                )
                .is_err()
            );
        }
        let actual = serde_json::to_value(&inputs)?;
        for (key, expected) in case
            .expected
            .as_object()
            .expect("expected generator fields")
        {
            if let Some(values) = expected.as_array() {
                let actual = actual[key].as_array().expect("actual array");
                assert_eq!(actual.len(), values.len());
                for (offset, (a, b)) in actual.iter().zip(values).enumerate() {
                    assert_eq!(a, b, "generator {index} {key}[{offset}]");
                }
            } else {
                assert_eq!(&actual[key], expected, "generator {index} {key}");
            }
        }
        let mut wrong = case.instance.clone();
        wrong.api_version = 2.into();
        assert!(
            case.definition
                .prepare(&wrong, &case.context, &case.device, &limits)
                .is_err()
        );
    }
    Ok(())
}
