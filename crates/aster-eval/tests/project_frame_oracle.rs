use aster_eval::{
    BundleLimits, EvaluationLimits, ExpressionLimits, FrameOutputContext, FramePlanRequest,
    FrameSceneInputs, GeneratorCatalog, GeneratorDeviceLimits, ProjectFrameResources, SceneLimits,
    SceneProject, SurfaceLimits, SurfaceRequest,
};
use aster_render_ir::ResourceMessage;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    generator_definition: aster_eval::GeneratorDefinition,
    generator_source: aster_eval::GeneratorProgramSource,
    sources: Vec<Input>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    project: aster_types::editor::Project,
    media: BTreeMap<String, Option<aster_render_ir::ResourceHash>>,
    packets: Vec<Packet>,
    pixels: Vec<Pixels>,
    generator_available: bool,
    shadow_map_size: u32,
    surface_revision: u64,
    realization_order: Vec<aster_render_ir::CompositionIdentity>,
    request: FramePlanRequest,
    outputs: Vec<Output>,
}
#[derive(Deserialize)]
struct Output {
    context: FrameOutputContext,
    bundle: Expected,
}
#[derive(Deserialize)]
struct Expected {
    plan: Plan,
    resources: Vec<Resource>,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct Resource {
    message: ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}

#[derive(Clone, Deserialize)]
struct Packet {
    message: ResourceMessage,
    bytes: Vec<u8>,
}
impl Packet {
    fn native(&self) -> Result<aster_render_ir::VerifiedResource, Box<dyn Error>> {
        let ResourceMessage::PutResource(message) = &self.message else {
            return Err("unexpected eviction".into());
        };
        let resource = aster_render_ir::VerifiedResource::new(
            message.kind,
            message.descriptor.clone(),
            self.bytes.clone(),
        )?;
        assert_eq!(resource.request().hash, message.hash);
        Ok(resource)
    }
}
#[derive(Deserialize)]
struct Pixels {
    frame: aster_render_ir::ResourceHash,
    pixels: Packet,
}

#[test]
#[ignore = "requires authenticated production TS project frame oracle"]
fn native_project_frames_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_PROJECT_FRAME_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert_eq!(oracle.cases.len(), 162);
    for input in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(input.path))?)),
            input.sha256
        );
    }
    let catalog = GeneratorCatalog::compile(
        vec![(oracle.generator_definition, oracle.generator_source)],
        aster_plugin::generator::GeneratorLimits::default(),
        BundleLimits::default(),
    )?;
    for (index, case) in oracle.cases.into_iter().enumerate().rev() {
        let scene = SceneProject::compile(
            case.project,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for (variant, output) in case.outputs.into_iter().enumerate().rev() {
            let input = FrameSceneInputs {
                visualization: output.context.visualization,
                text_bounds: BTreeMap::new(),
                motion_text_bounds: BTreeMap::new(),
                text_layouts: BTreeMap::new(),
                locale: "en-US".into(),
            };
            let resources = ProjectFrameResources {
                media: case.media.clone(),
                materials: None,
                packets: case
                    .packets
                    .iter()
                    .map(Packet::native)
                    .collect::<Result<_, _>>()?,
                pixels: case
                    .pixels
                    .iter()
                    .map(|p| {
                        Ok(aster_eval::BundleMediaPixels {
                            frame: p.frame.clone(),
                            pixels: p.pixels.native()?,
                        })
                    })
                    .collect::<Result<_, Box<dyn Error>>>()?,
                temporal: Vec::new(),
                audio: None,
                generator_device: GeneratorDeviceLimits {
                    memory_budget_mb: 256.0,
                    storage_byte_limit: 134217728,
                    dispatch_workgroup_limit: 65535,
                },
                surface_request: SurfaceRequest {
                    revision: case.surface_revision,
                    max_texture_dimension: 8192,
                    memory_budget_mb: Some(256.0),
                    render_scale: 1.0,
                },
                surface_limits: SurfaceLimits::default(),
                output: output.context,
                effect_mip_levels: 4,
                shadow_map_size: case.shadow_map_size,
            };
            let mut realization_order = Vec::new();
            let bundle = scene.plan_project_frame(
                &case.request,
                &input,
                resources,
                &catalog,
                BundleLimits::default(),
                |generator| {
                    realization_order.push(generator.instance_id.clone());
                    let Some(aster_render_ir::PlanSlice::SceneGenerator(invocation)) =
                        generator.plan.metadata.slices.first()
                    else {
                        return Err(aster_eval::EvaluationError::InvalidScene(
                            "missing invocation".into(),
                        ));
                    };
                    Ok(if case.generator_available {
                        aster_render_ir::PrecompositionGeneratorExecution::Ready {
                            capacity: invocation.capacity,
                            effective_count: invocation.effective_count,
                        }
                    } else {
                        aster_render_ir::PrecompositionGeneratorExecution::Unavailable
                    })
                },
            )?;
            assert_eq!(
                realization_order, case.realization_order,
                "generator realization order"
            );
            assert_eq!(
                serde_json::to_value(bundle.plan.metadata)?,
                output.bundle.plan.metadata,
                "project frame metadata {index}/{variant}"
            );
            assert_eq!(
                bundle.plan.blobs, output.bundle.plan.blobs,
                "project frame bytes {index}/{variant}"
            );
            assert_eq!(bundle.resources.len(), output.bundle.resources.len());
            for (actual, expected) in bundle.resources.into_iter().zip(output.bundle.resources) {
                assert_eq!(
                    ResourceMessage::PutResource(actual.request().clone()),
                    expected.message,
                    "project resource identity {index}/{variant}"
                );
                assert_eq!(actual.bytes().len(), expected.byte_length);
                assert_eq!(
                    format!("{:x}", Sha256::digest(actual.bytes())),
                    expected.payload_sha256,
                    "project resource bytes {index}/{variant}"
                );
            }
        }
    }
    Ok(())
}
