use aster_eval::{
    BundleEffect, BundleGenerator, BundleLimits, BundleMediaPixels, EffectExecutionPlan,
    FrameBundleInput, FrameOutputPlans, LutPlan, NativeBundle, NativePlan, PreparedEffect,
    PreparedEffectProgram, SurfaceBundleScene,
};
use aster_render_ir::{
    CompositionIdentity, FramePlanSliceV1, PlanSlice, PrecompositionGeneratorExecution,
    ResourceHash, ResourceMessage, VerifiedResource,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Plan {
    metadata: FramePlanSliceV1,
    blobs: Vec<Vec<u8>>,
}
#[derive(Deserialize)]
struct Packet {
    message: ResourceMessage,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
struct ResourceExpectation {
    message: ResourceMessage,
    byte_length: usize,
    payload_sha256: String,
}
#[derive(Deserialize)]
struct Expected {
    plan: Plan,
    resources: Vec<ResourceExpectation>,
}
#[derive(Deserialize)]
struct SuppliedBundle {
    plan: Plan,
    resources: Vec<Packet>,
}
#[derive(Deserialize)]
struct Effect {
    id: CompositionIdentity,
    status: String,
    execution: Plan,
    program: Option<Plan>,
    lut: Option<Lut>,
    error_utf16: Vec<u16>,
}
#[derive(Deserialize)]
struct Lut {
    #[serde(flatten)]
    packet: Packet,
    label: String,
}
#[derive(Deserialize)]
struct Generator {
    id: CompositionIdentity,
    plan: Plan,
    shaders: Vec<Packet>,
    layer_name_utf16: Vec<u16>,
    plugin_id_utf16: Vec<u16>,
    execution: PrecompositionGeneratorExecution,
}
#[derive(Deserialize)]
struct Pixels {
    frame: ResourceHash,
    pixels: Packet,
}
#[derive(Deserialize)]
struct Output {
    auxiliary: Option<Plan>,
    motion: Plan,
    output: Plan,
    effect: Option<Plan>,
}
#[derive(Deserialize)]
struct Frame {
    scene: Plan,
    root: Plan,
    post: Plan,
    output: Output,
    shadow_map_size: u32,
    effects: Vec<Effect>,
    generators: Vec<Generator>,
    resources: Vec<Packet>,
    precompositions: Option<SuppliedBundle>,
    temporal: Vec<Plan>,
    media_pixels: Vec<Pixels>,
    expected: Expected,
}
#[derive(Deserialize)]
struct Scene {
    target_id: CompositionIdentity,
    label_utf16: Vec<u16>,
    scene: Plan,
    commands: Plan,
    draw_scene_indices: Vec<u32>,
    effects: Vec<Effect>,
    generators: Vec<Generator>,
}
#[derive(Deserialize)]
struct Surface {
    graph: Plan,
    scenes: Vec<Scene>,
    resources: Vec<Packet>,
    media_pixels: Vec<Pixels>,
    expected: Expected,
}
#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    frames: Vec<Frame>,
    surfaces: Vec<Surface>,
    outputs: Vec<OutputCase>,
}
#[derive(Deserialize)]
struct OutputCase {
    input: Output,
    accepted: bool,
}
impl Output {
    fn native(self) -> FrameOutputPlans {
        FrameOutputPlans {
            auxiliary: self.auxiliary.map(Plan::native),
            motion: self.motion.native(),
            output: self.output.native(),
            effect: self.effect.map(Plan::native),
        }
    }
}
impl Plan {
    fn native(self) -> NativePlan {
        NativePlan {
            metadata: self.metadata,
            blobs: self.blobs,
        }
    }
}
impl Packet {
    fn native(self) -> Result<VerifiedResource, Box<dyn Error>> {
        let ResourceMessage::PutResource(message) = self.message else {
            return Err("unexpected eviction".into());
        };
        let value = VerifiedResource::new(message.kind, message.descriptor, self.bytes)?;
        assert_eq!(value.request().hash, message.hash);
        Ok(value)
    }
}
impl Effect {
    fn native(self) -> Result<BundleEffect, Box<dyn Error>> {
        let Some(PlanSlice::EffectExecution(slice)) = self.execution.metadata.slices.first() else {
            return Err("missing effect execution".into());
        };
        let execution = EffectExecutionPlan {
            route: slice.route.clone(),
            blend_mode: slice.blend_mode.clone(),
            plan: self.execution.native(),
        };
        let prepared = match self.status.as_str() {
            "direct" => PreparedEffect::Direct { execution },
            "skipped" => PreparedEffect::Skipped { execution },
            "failed" => PreparedEffect::Failed {
                execution,
                error_utf16: self.error_utf16,
            },
            "ready" => {
                let lut = self.lut.ok_or("missing LUT")?;
                PreparedEffect::Ready {
                    execution,
                    prepared: Box::new(PreparedEffectProgram {
                        program: self.program.ok_or("missing effect program")?.native(),
                        lut: LutPlan {
                            resource: lut.packet.native()?,
                            label: lut.label,
                        },
                    }),
                }
            }
            _ => return Err("invalid effect status".into()),
        };
        Ok(BundleEffect {
            instance_id: self.id,
            prepared,
        })
    }
}
impl Generator {
    fn native(self) -> Result<BundleGenerator, Box<dyn Error>> {
        Ok(BundleGenerator {
            instance_id: self.id,
            plan: self.plan.native(),
            shaders: self
                .shaders
                .into_iter()
                .map(Packet::native)
                .collect::<Result<_, _>>()?,
            layer_name_utf16: self.layer_name_utf16,
            plugin_id_utf16: self.plugin_id_utf16,
            execution: self.execution,
        })
    }
}
impl Pixels {
    fn native(self) -> Result<BundleMediaPixels, Box<dyn Error>> {
        Ok(BundleMediaPixels {
            frame: self.frame,
            pixels: self.pixels.native()?,
        })
    }
}
impl Expected {
    fn compare(&self, actual: NativeBundle, context: &str) {
        assert_eq!(
            actual.plan.metadata, self.plan.metadata,
            "metadata {context}"
        );
        assert_eq!(actual.plan.blobs, self.plan.blobs, "bytes {context}");
        assert_eq!(
            actual.resources.len(),
            self.resources.len(),
            "resource count {context}"
        );
        for (actual, expected) in actual.resources.iter().zip(&self.resources) {
            assert_eq!(
                ResourceMessage::PutResource(actual.request().clone()),
                expected.message,
                "resource {context}"
            );
            assert_eq!(actual.bytes().len(), expected.byte_length);
            assert_eq!(
                format!("{:x}", Sha256::digest(actual.bytes())),
                expected.payload_sha256
            );
        }
    }
}
#[test]
#[ignore = "requires authenticated TS bundle assembly oracle"]
fn native_bundles_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_BUNDLE_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.frames.len() >= 9 && !oracle.surfaces.is_empty());
    assert_eq!(oracle.outputs.len(), 432);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (index, case) in oracle.outputs.into_iter().enumerate() {
        assert_eq!(
            case.input.native().validate().is_ok(),
            case.accepted,
            "output consistency {index}"
        );
    }
    for (index, frame) in oracle.frames.into_iter().enumerate() {
        let precompositions = frame
            .precompositions
            .map(|b| {
                Ok::<_, Box<dyn Error>>(NativeBundle {
                    plan: b.plan.native(),
                    resources: b
                        .resources
                        .into_iter()
                        .map(Packet::native)
                        .collect::<Result<_, _>>()?,
                })
            })
            .transpose()?;
        let input = FrameBundleInput {
            scene: frame.scene.native(),
            root: frame.root.native(),
            post: frame.post.native(),
            output: FrameOutputPlans {
                auxiliary: frame.output.auxiliary.map(Plan::native),
                motion: frame.output.motion.native(),
                output: frame.output.output.native(),
                effect: frame.output.effect.map(Plan::native),
            },
            shadow_map_size: frame.shadow_map_size,
            effects: frame
                .effects
                .into_iter()
                .map(Effect::native)
                .collect::<Result<_, _>>()?,
            generators: frame
                .generators
                .into_iter()
                .map(Generator::native)
                .collect::<Result<_, _>>()?,
            resources: frame
                .resources
                .into_iter()
                .map(Packet::native)
                .collect::<Result<_, _>>()?,
            precompositions,
            temporal: frame.temporal.into_iter().map(Plan::native).collect(),
            media_pixels: frame
                .media_pixels
                .into_iter()
                .map(Pixels::native)
                .collect::<Result<_, _>>()?,
        };
        frame.expected.compare(
            NativeBundle::frame(input, BundleLimits::default())?,
            &format!("frame {index}"),
        );
    }
    for (index, surface) in oracle.surfaces.into_iter().enumerate() {
        let scenes = surface
            .scenes
            .into_iter()
            .map(|s| {
                Ok::<_, Box<dyn Error>>(SurfaceBundleScene {
                    target_id: s.target_id,
                    label_utf16: s.label_utf16,
                    scene: s.scene.native(),
                    commands: s.commands.native(),
                    draw_scene_indices: s.draw_scene_indices,
                    effects: s
                        .effects
                        .into_iter()
                        .map(Effect::native)
                        .collect::<Result<_, _>>()?,
                    generators: s
                        .generators
                        .into_iter()
                        .map(Generator::native)
                        .collect::<Result<_, _>>()?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let actual = NativeBundle::surfaces(
            surface.graph.native(),
            scenes,
            surface
                .resources
                .into_iter()
                .map(Packet::native)
                .collect::<Result<_, _>>()?,
            surface
                .media_pixels
                .into_iter()
                .map(Pixels::native)
                .collect::<Result<_, _>>()?,
            BundleLimits::default(),
        )?;
        surface
            .expected
            .compare(actual, &format!("surface {index}"));
    }
    Ok(())
}
