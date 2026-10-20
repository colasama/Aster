use aster_eval::{
    BundleLimits, BundleResources, EffectContext, EffectExecutionPlan, EffectLimits,
    EffectPreparation, EffectTrack, EvaluationLimits, ExpressionLimits, LutPlan, NativePlan,
    PreparedEffect,
};
use aster_render_ir::{FrameHeaderSlice, ResourceDescriptor, ResourceHash, ResourceKind};
use aster_types::editor::Layer;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    layer: Layer,
    header: FrameHeaderSlice,
    context: EffectContext,
    instance_id: String,
    time: f64,
    pixel_scale: f64,
    mip_level_count: u32,
    expected: Expected,
}
#[derive(Deserialize)]
struct Expected {
    bundle: BundleExpectation,
    status: String,
    execution: Plan,
    plan: Option<Plan>,
    lut: Option<Lut>,
}
#[derive(Deserialize)]
struct BundleExpectation {
    records: Vec<aster_render_ir::PrecompositionEffectRecord>,
    resources: Vec<ResourceExpectation>,
}
#[derive(Deserialize)]
struct ResourceExpectation {
    message: aster_render_ir::ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct Lut {
    hash: ResourceHash,
    kind: ResourceKind,
    descriptor: ResourceDescriptor,
    bytes: Vec<u8>,
    label: String,
}
impl Plan {
    fn compare(&self, actual: &NativePlan, context: &str) -> Result<(), Box<dyn Error>> {
        assert_eq!(
            self.metadata,
            serde_json::to_value(&actual.metadata)?,
            "metadata {context}"
        );
        assert_eq!(self.blobs, actual.blobs, "bytes {context}");
        Ok(())
    }
}
#[test]
#[ignore = "requires independently captured TS effect plan oracle"]
fn native_effect_plans_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_EFFECT_PLAN_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() > 900);
    for input in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(input.path))?)),
            input.sha256
        );
    }
    for (index, case) in oracle.cases.iter().enumerate().rev() {
        let execution = EffectExecutionPlan::build(
            case.header.clone(),
            &case.layer,
            &case.instance_id,
            case.context,
        )?;
        case.expected
            .execution
            .compare(&execution.plan, &format!("execution {index}"))?;
        let tracks = case
            .layer
            .effects
            .iter()
            .map(|e| {
                EffectTrack::compile(
                    e,
                    &EffectLimits::default(),
                    &EvaluationLimits::default(),
                    &ExpressionLimits::default(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let prepared = PreparedEffect::prepare(
            &case.layer,
            &tracks,
            EffectPreparation {
                header: case.header.clone(),
                instance_id: case.instance_id.clone(),
                context: case.context,
                time: case.time,
                pixel_scale: case.pixel_scale,
                mip_level_count: case.mip_level_count,
            },
        )?;
        let mut resources = BundleResources::new(BundleLimits::default())?;
        let record = prepared.record(
            aster_render_ir::CompositionIdentity::Unicode(case.instance_id.clone()),
            &mut resources,
        )?;
        assert_eq!(
            vec![record],
            case.expected.bundle.records,
            "effect resource record {index}"
        );
        let resources = resources.finish();
        assert_eq!(resources.len(), case.expected.bundle.resources.len());
        for (actual, expected) in resources.iter().zip(&case.expected.bundle.resources) {
            assert_eq!(
                aster_render_ir::ResourceMessage::PutResource(actual.request().clone()),
                expected.message,
                "resource {index}"
            );
            assert_eq!(actual.bytes().len(), expected.byte_length);
            assert_eq!(
                format!("{:x}", Sha256::digest(actual.bytes())),
                expected.payload_sha256,
                "resource bytes {index}"
            );
        }
        if let Some(expected) = &case.expected.lut {
            let lut = LutPlan::prepare(&case.layer)?;
            assert_eq!(
                lut.resource.request().hash,
                expected.hash,
                "LUT hash {index}"
            );
            assert_eq!(lut.resource.request().kind, expected.kind);
            assert_eq!(lut.resource.request().descriptor, expected.descriptor);
            assert_eq!(lut.resource.bytes(), expected.bytes);
            assert_eq!(lut.label, expected.label);
        }
        let hash = case
            .expected
            .lut
            .as_ref()
            .map_or_else(|| ResourceHash("0".repeat(64)), |l| l.hash.clone());
        let plan = execution.layer_program(
            &tracks,
            case.time,
            case.pixel_scale,
            case.mip_level_count,
            hash,
        );
        if case.expected.status == "failed" {
            assert!(plan.is_err(), "failed {index}");
            continue;
        }
        let plan = plan?;
        match (&case.expected.plan, plan) {
            (Some(expected), Some(actual)) => {
                expected.compare(&actual, &format!("program {index}"))?
            }
            (None, None) => {}
            _ => panic!("producer presence {index}"),
        }
    }
    Ok(())
}
