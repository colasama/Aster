use super::{GeneratorDefinition, GeneratorInputs};
use crate::{EvaluationError, NativePlan};
use aster_plugin::generator::{
    GeneratorBlendMode, GeneratorComputePhase, GeneratorCullMode, GeneratorDepthMode,
    GeneratorLimits,
};
use aster_render_ir::{
    BufferResourceDescriptor, CompositionIdentity, ContractLevel, EffectBlendMode, ElementType,
    FrameHeaderSlice, GeneratorAuxiliary, GeneratorBlend, GeneratorCompute, GeneratorCull,
    GeneratorDepth, GeneratorGraph, GeneratorPhase, GeneratorProgram, GeneratorVariant, PlanSlice,
    ResourceDescriptor, ResourceKind, SceneGeneratorSlice, VerifiedResource,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// Sources must already be admitted by the plugin or bundled-shader boundary.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorProgramSource {
    pub plugin_name: String,
    pub runtime_key: String,
    pub shader_sources: BTreeMap<String, String>,
}
#[derive(Clone)]
pub struct NativeGeneratorProgram {
    pub description: GeneratorProgram,
    pub shaders: Vec<VerifiedResource>,
}
#[derive(Clone, Deserialize)]
pub struct GeneratorInvocation {
    pub instance_id: CompositionIdentity,
    pub selection_id: CompositionIdentity,
    pub blend_mode: EffectBlendMode,
}
impl NativeGeneratorProgram {
    pub fn compile(
        definition: &GeneratorDefinition,
        source: &GeneratorProgramSource,
        limits: &GeneratorLimits,
    ) -> Result<Self, EvaluationError> {
        definition.validate(limits)?;
        let graph = &definition.graph;
        let paths: BTreeSet<_> = graph
            .compute_passes
            .iter()
            .map(|p| p.shader.as_str())
            .chain(graph.render_variants.iter().flat_map(|v| {
                std::iter::once(v.shader.as_str())
                    .chain(v.auxiliary.iter().map(|a| a.shader.as_str()))
            }))
            .collect();
        let mut hashes = BTreeMap::new();
        let mut shaders = BTreeMap::new();
        let mut total = 0;
        for path in paths {
            let bytes = source
                .shader_sources
                .get(path)
                .ok_or_else(|| {
                    EvaluationError::InvalidScene(format!("runtime shader {path} is unavailable"))
                })?
                .as_bytes();
            if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
                return Err(EvaluationError::InvalidScene(
                    "generator shader byte budget".into(),
                ));
            }
            let length = bytes.len() as u32;
            let resource = VerifiedResource::new(
                ResourceKind::Buffer,
                ResourceDescriptor::Buffer(BufferResourceDescriptor {
                    element_type: ElementType::U8,
                    element_count: length,
                    byte_length: length,
                }),
                bytes.to_vec(),
            )
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
            if !shaders.contains_key(&resource.request().hash) {
                total += bytes.len();
            }
            if total > 16 * 1024 * 1024 {
                return Err(EvaluationError::InvalidScene(
                    "generator total shader byte budget".into(),
                ));
            }
            hashes.insert(path, resource.request().hash.clone());
            shaders.insert(resource.request().hash.clone(), resource);
        }
        let compute_passes = graph
            .compute_passes
            .iter()
            .map(|p| GeneratorCompute {
                id: p.id.clone(),
                shader: hashes[p.shader.as_str()].clone(),
                entry_point: p.entry_point.clone(),
                workgroup_size: p.workgroup_size,
                phase: match p.phase {
                    GeneratorComputePhase::Simulation => GeneratorPhase::Simulation,
                    GeneratorComputePhase::PreRender => GeneratorPhase::PreRender,
                },
            })
            .collect();
        let render_variants = graph
            .render_variants
            .iter()
            .map(|v| GeneratorVariant {
                id: v.id.clone(),
                shader: hashes[v.shader.as_str()].clone(),
                vertex_entry: v.vertex_entry.clone(),
                fragment_entry: v.fragment_entry.clone(),
                vertex_count: v.vertex_count,
                blend: match v.blend {
                    GeneratorBlendMode::Normal => GeneratorBlend::Normal,
                    GeneratorBlendMode::Add => GeneratorBlend::Add,
                    GeneratorBlendMode::Multiply => GeneratorBlend::Multiply,
                    GeneratorBlendMode::Screen => GeneratorBlend::Screen,
                    GeneratorBlendMode::Overlay => GeneratorBlend::Overlay,
                    GeneratorBlendMode::Layer => GeneratorBlend::Layer,
                },
                depth: match v.depth {
                    GeneratorDepthMode::None => GeneratorDepth::None,
                    GeneratorDepthMode::Read => GeneratorDepth::Read,
                    GeneratorDepthMode::ReadWrite => GeneratorDepth::ReadWrite,
                },
                cull: match v.cull {
                    GeneratorCullMode::None => GeneratorCull::None,
                    GeneratorCullMode::Front => GeneratorCull::Front,
                    GeneratorCullMode::Back => GeneratorCull::Back,
                },
                auxiliary: v.auxiliary.as_ref().map(|a| GeneratorAuxiliary {
                    shader: hashes[a.shader.as_str()].clone(),
                    vertex_entry: a.vertex_entry.clone(),
                    fragment_entry: a.fragment_entry.clone(),
                }),
            })
            .collect();
        let description = GeneratorProgram {
            source_key: CompositionIdentity::Unicode(format!(
                "{}:{}:{}",
                definition.plugin_id, definition.node_type, source.runtime_key
            )),
            label: CompositionIdentity::Unicode(source.plugin_name.clone()),
            audio_analysis: definition.audio_analysis,
            graph: GeneratorGraph {
                api_version: definition.api_version,
                max_instances: graph.max_instances,
                instance_stride: graph.instance_stride,
                compute_passes,
                render_variants,
            },
        };
        description
            .validate(&shaders.keys().cloned().collect::<Vec<_>>())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        Ok(Self {
            description,
            shaders: shaders.into_values().collect(),
        })
    }
}
impl GeneratorInputs {
    pub fn plan(
        &self,
        header: FrameHeaderSlice,
        invocation: GeneratorInvocation,
        program: &NativeGeneratorProgram,
        audio: Option<&[u32]>,
    ) -> Result<NativePlan, EvaluationError> {
        if self.context.len() != 52
            || self.parameters.len() != 512
            || audio.is_some_and(|a| a.len() != 2320 || !program.description.audio_analysis)
        {
            return Err(EvaluationError::InvalidScene(
                "generator numeric payload length".into(),
            ));
        }
        let bytes = self
            .context
            .iter()
            .chain(&self.parameters)
            .chain(&self.indirect)
            .chain(audio.into_iter().flatten())
            .flat_map(|v| v.to_le_bytes())
            .collect();
        NativePlan::single(
            header,
            ContractLevel::SceneGeneratorSliceV1,
            PlanSlice::SceneGenerator(SceneGeneratorSlice {
                blob_index: 0,
                instance_id: invocation.instance_id,
                selection_id: invocation.selection_id,
                blend_mode: invocation.blend_mode,
                program: program.description.clone(),
                variant_index: u32::try_from(self.variant_index).map_err(|_| {
                    EvaluationError::InvalidScene("generator variant index overflow".into())
                })?,
                requested_count: self.requested_count,
                effective_count: self.effective_count,
                capacity: self.capacity,
                dispatches: self.dispatches.clone(),
                has_audio: audio.is_some(),
            }),
            ElementType::U8,
            bytes,
            program
                .shaders
                .iter()
                .map(|r| r.request().hash.clone())
                .collect(),
        )
    }
}
