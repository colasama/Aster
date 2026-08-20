//! Declarative, quota-bounded render graphs for GPU-only plugin effects.
//!
//! Graph validation is intentionally independent from a GPU backend. A host validates an
//! untrusted declaration against the current output size before compiling shaders or allocating
//! resources, then executes only the returned deterministic plan.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::valid_shader_path;

pub const GRAPH_API_VERSION: u32 = 1;

/// A portable safety envelope based on WebGPU's guaranteed minimum limits.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GraphResourceQuota {
    pub max_passes: u32,
    pub max_temporary_textures: u32,
    pub max_dependency_edges: u32,
    pub max_texture_dimension: u32,
    pub max_transient_bytes: u64,
    pub max_sampled_textures_per_pass: u32,
    pub max_storage_textures_per_pass: u32,
    pub max_color_attachments_per_pass: u32,
    pub max_workgroups_per_pass: u64,
    pub max_total_workgroups: u64,
}

impl Default for GraphResourceQuota {
    fn default() -> Self {
        Self {
            max_passes: 32,
            max_temporary_textures: 24,
            max_dependency_edges: 128,
            max_texture_dimension: 8_192,
            max_transient_bytes: 512 * 1024 * 1024,
            max_sampled_textures_per_pass: 16,
            max_storage_textures_per_pass: 4,
            max_color_attachments_per_pass: 4,
            max_workgroups_per_pass: 4_194_304,
            max_total_workgroups: 16_777_216,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GraphValidationContext {
    pub output_width: u32,
    pub output_height: u32,
    #[serde(default)]
    pub quota: GraphResourceQuota,
}

impl GraphValidationContext {
    #[must_use]
    pub fn new(output_width: u32, output_height: u32) -> Self {
        Self {
            output_width,
            output_height,
            quota: GraphResourceQuota::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderGraph {
    pub api_version: u32,
    #[serde(default)]
    pub temporary_textures: Vec<TemporaryTexture>,
    pub passes: Vec<GraphPass>,
}

impl RenderGraph {
    pub fn validate(
        &self,
        context: GraphValidationContext,
    ) -> Result<ValidatedGraph, GraphValidationError> {
        GraphValidator::new(self, context).validate()
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemporaryTexture {
    pub id: String,
    pub extent: TextureExtent,
    pub format: TextureFormat,
    pub usage: BTreeSet<TextureUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TextureExtent {
    FullFrame,
    Scale { numerator: u32, denominator: u32 },
    Fixed { width: u32, height: u32 },
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum TextureFormat {
    Rgba8Unorm,
    Rgba16Float,
    R32Float,
}

impl TextureFormat {
    const fn bytes_per_pixel(self) -> u64 {
        match self {
            Self::Rgba8Unorm | Self::R32Float => 4,
            Self::Rgba16Float => 8,
        }
    }
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum TextureUsage {
    Sampled,
    Storage,
    RenderAttachment,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum TextureRef {
    Source,
    Output,
    Temporary(String),
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphPass {
    Compute {
        id: String,
        shader: String,
        entry_point: String,
        #[serde(default)]
        sampled_inputs: Vec<TextureRef>,
        storage_outputs: Vec<TextureRef>,
        dispatch: ComputeDispatch,
        #[serde(default)]
        depends_on: Vec<String>,
    },
    Render {
        id: String,
        shader: String,
        vertex_entry: String,
        fragment_entry: String,
        #[serde(default)]
        sampled_inputs: Vec<TextureRef>,
        color_outputs: Vec<TextureRef>,
        #[serde(default)]
        depends_on: Vec<String>,
    },
}

impl GraphPass {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Compute { id, .. } | Self::Render { id, .. } => id,
        }
    }

    fn shader(&self) -> &str {
        match self {
            Self::Compute { shader, .. } | Self::Render { shader, .. } => shader,
        }
    }

    fn dependencies(&self) -> &[String] {
        match self {
            Self::Compute { depends_on, .. } | Self::Render { depends_on, .. } => depends_on,
        }
    }

    fn sampled_inputs(&self) -> &[TextureRef] {
        match self {
            Self::Compute { sampled_inputs, .. } | Self::Render { sampled_inputs, .. } => {
                sampled_inputs
            }
        }
    }

    fn outputs(&self) -> &[TextureRef] {
        match self {
            Self::Compute {
                storage_outputs, ..
            } => storage_outputs,
            Self::Render { color_outputs, .. } => color_outputs,
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ComputeDispatch {
    /// Dispatch enough workgroups to cover a texture. The host computes ceil(size / workgroup).
    ForTexture {
        texture: TextureRef,
        workgroup_size: [u32; 3],
    },
    Fixed {
        workgroups: [u32; 3],
    },
}

/// The only graph representation a host should execute.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedGraph {
    /// Stable pass indices in execution order.
    pub execution_order: Vec<usize>,
    /// Concrete dispatch counts keyed by compute pass ID.
    pub compute_dispatches: BTreeMap<String, [u32; 3]>,
    pub estimated_transient_bytes: u64,
    pub dependency_edges: u32,
}

#[derive(Debug, Error, PartialEq)]
pub enum GraphValidationError {
    #[error("graph API version {0} is unsupported")]
    UnsupportedApi(u32),
    #[error("output dimensions must be non-zero")]
    EmptyOutput,
    #[error("graph declares {actual} {resource}; quota allows {limit}")]
    QuotaExceeded {
        resource: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("graph identifier `{0}` is invalid")]
    InvalidIdentifier(String),
    #[error("graph identifier `{0}` is declared more than once")]
    DuplicateIdentifier(String),
    #[error("shader path `{0}` must be a relative .wgsl path")]
    InvalidShaderPath(String),
    #[error("entry point `{0}` is invalid")]
    InvalidEntryPoint(String),
    #[error("temporary texture `{0}` has an invalid extent")]
    InvalidTextureExtent(String),
    #[error("temporary texture `{0}` exceeds the maximum dimension")]
    TextureDimensionExceeded(String),
    #[error("texture `{0:?}` is not declared")]
    UndeclaredTexture(TextureRef),
    #[error("pass `{pass}` requires {required:?} usage on texture `{texture}`")]
    MissingTextureUsage {
        pass: String,
        texture: String,
        required: TextureUsage,
    },
    #[error("source texture cannot be written")]
    SourceWrite,
    #[error("output texture cannot be sampled")]
    OutputRead,
    #[error("texture `{0:?}` has more than one writer")]
    MultipleWriters(TextureRef),
    #[error("temporary texture `{0}` has no writer")]
    UnwrittenTemporary(String),
    #[error("output texture has no writer")]
    UnwrittenOutput,
    #[error("pass `{pass}` reads and writes texture `{texture:?}`")]
    ReadWriteAlias { pass: String, texture: TextureRef },
    #[error("pass `{pass}` depends on unknown pass `{dependency}`")]
    UnknownDependency { pass: String, dependency: String },
    #[error("render graph dependencies contain a cycle")]
    DependencyCycle,
    #[error("compute pass `{pass}` has an invalid workgroup size")]
    InvalidWorkgroupSize { pass: String },
    #[error("compute pass `{pass}` has an invalid dispatch size")]
    InvalidDispatchSize { pass: String },
}

struct GraphValidator<'a> {
    graph: &'a RenderGraph,
    context: GraphValidationContext,
    texture_sizes: BTreeMap<String, [u32; 2]>,
    texture_usage: BTreeMap<String, BTreeSet<TextureUsage>>,
    pass_ids: BTreeMap<String, usize>,
}

type DependencyPlan = (Vec<usize>, u32, BTreeMap<TextureRef, usize>);

impl<'a> GraphValidator<'a> {
    fn new(graph: &'a RenderGraph, context: GraphValidationContext) -> Self {
        Self {
            graph,
            context,
            texture_sizes: BTreeMap::new(),
            texture_usage: BTreeMap::new(),
            pass_ids: BTreeMap::new(),
        }
    }

    fn validate(mut self) -> Result<ValidatedGraph, GraphValidationError> {
        if self.graph.api_version != GRAPH_API_VERSION {
            return Err(GraphValidationError::UnsupportedApi(self.graph.api_version));
        }
        if self.context.output_width == 0 || self.context.output_height == 0 {
            return Err(GraphValidationError::EmptyOutput);
        }
        check_quota(
            "passes",
            self.graph.passes.len() as u64,
            self.context.quota.max_passes as u64,
        )?;
        check_quota(
            "temporary textures",
            self.graph.temporary_textures.len() as u64,
            self.context.quota.max_temporary_textures as u64,
        )?;

        let transient_bytes = self.validate_textures()?;
        self.validate_pass_declarations()?;
        let (execution_order, dependency_edges, writers) = self.validate_dependencies()?;
        self.ensure_all_outputs_written(&writers)?;
        let compute_dispatches = self.validate_dispatches()?;

        Ok(ValidatedGraph {
            execution_order,
            compute_dispatches,
            estimated_transient_bytes: transient_bytes,
            dependency_edges,
        })
    }

    fn validate_textures(&mut self) -> Result<u64, GraphValidationError> {
        let mut transient_bytes = 0_u64;
        for texture in &self.graph.temporary_textures {
            validate_identifier(&texture.id)?;
            if self.texture_sizes.contains_key(&texture.id) {
                return Err(GraphValidationError::DuplicateIdentifier(
                    texture.id.clone(),
                ));
            }
            let size = texture.extent.resolve(
                self.context.output_width,
                self.context.output_height,
                &texture.id,
            )?;
            if size
                .into_iter()
                .any(|axis| axis > self.context.quota.max_texture_dimension)
            {
                return Err(GraphValidationError::TextureDimensionExceeded(
                    texture.id.clone(),
                ));
            }
            let bytes = u64::from(size[0])
                .checked_mul(u64::from(size[1]))
                .and_then(|pixels| pixels.checked_mul(texture.format.bytes_per_pixel()))
                .ok_or_else(|| GraphValidationError::InvalidTextureExtent(texture.id.clone()))?;
            transient_bytes =
                transient_bytes
                    .checked_add(bytes)
                    .ok_or(GraphValidationError::QuotaExceeded {
                        resource: "transient bytes",
                        actual: u64::MAX,
                        limit: self.context.quota.max_transient_bytes,
                    })?;
            self.texture_sizes.insert(texture.id.clone(), size);
            self.texture_usage
                .insert(texture.id.clone(), texture.usage.clone());
        }
        check_quota(
            "transient bytes",
            transient_bytes,
            self.context.quota.max_transient_bytes,
        )?;
        Ok(transient_bytes)
    }

    fn validate_pass_declarations(&mut self) -> Result<(), GraphValidationError> {
        for (index, pass) in self.graph.passes.iter().enumerate() {
            validate_identifier(pass.id())?;
            if self.pass_ids.insert(pass.id().into(), index).is_some() {
                return Err(GraphValidationError::DuplicateIdentifier(pass.id().into()));
            }
            if !valid_shader_path(pass.shader()) {
                return Err(GraphValidationError::InvalidShaderPath(
                    pass.shader().into(),
                ));
            }
            let entries: &[&str] = match pass {
                GraphPass::Compute { entry_point, .. } => &[entry_point],
                GraphPass::Render {
                    vertex_entry,
                    fragment_entry,
                    ..
                } => &[vertex_entry, fragment_entry],
            };
            if let Some(entry) = entries.iter().find(|entry| !valid_identifier(entry)) {
                return Err(GraphValidationError::InvalidEntryPoint(
                    (*entry).to_string(),
                ));
            }
            check_quota(
                "sampled textures per pass",
                pass.sampled_inputs().len() as u64,
                self.context.quota.max_sampled_textures_per_pass as u64,
            )?;
            let output_limit = match pass {
                GraphPass::Compute { .. } => self.context.quota.max_storage_textures_per_pass,
                GraphPass::Render { .. } => self.context.quota.max_color_attachments_per_pass,
            };
            check_quota(
                "outputs per pass",
                pass.outputs().len() as u64,
                output_limit as u64,
            )?;
            if pass.outputs().is_empty() {
                return Err(GraphValidationError::QuotaExceeded {
                    resource: "outputs per pass",
                    actual: 0,
                    limit: output_limit as u64,
                });
            }
            self.validate_pass_resources(pass)?;
        }
        Ok(())
    }

    fn validate_pass_resources(&self, pass: &GraphPass) -> Result<(), GraphValidationError> {
        let inputs = pass
            .sampled_inputs()
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let outputs = pass.outputs().iter().cloned().collect::<BTreeSet<_>>();
        if let Some(texture) = inputs.intersection(&outputs).next() {
            return Err(GraphValidationError::ReadWriteAlias {
                pass: pass.id().into(),
                texture: texture.clone(),
            });
        }
        for input in &inputs {
            match input {
                TextureRef::Source => {}
                TextureRef::Output => return Err(GraphValidationError::OutputRead),
                TextureRef::Temporary(id) => {
                    self.require_usage(pass.id(), id, TextureUsage::Sampled)?;
                }
            }
        }
        let required = match pass {
            GraphPass::Compute { .. } => TextureUsage::Storage,
            GraphPass::Render { .. } => TextureUsage::RenderAttachment,
        };
        for output in &outputs {
            match output {
                TextureRef::Source => return Err(GraphValidationError::SourceWrite),
                TextureRef::Output => {}
                TextureRef::Temporary(id) => self.require_usage(pass.id(), id, required)?,
            }
        }
        Ok(())
    }

    fn require_usage(
        &self,
        pass: &str,
        texture: &str,
        required: TextureUsage,
    ) -> Result<(), GraphValidationError> {
        let usage = self.texture_usage.get(texture).ok_or_else(|| {
            GraphValidationError::UndeclaredTexture(TextureRef::Temporary(texture.into()))
        })?;
        if !usage.contains(&required) {
            return Err(GraphValidationError::MissingTextureUsage {
                pass: pass.into(),
                texture: texture.into(),
                required,
            });
        }
        Ok(())
    }

    fn validate_dependencies(&self) -> Result<DependencyPlan, GraphValidationError> {
        let mut writers = BTreeMap::new();
        for (index, pass) in self.graph.passes.iter().enumerate() {
            for output in pass.outputs() {
                if writers.insert(output.clone(), index).is_some() {
                    return Err(GraphValidationError::MultipleWriters(output.clone()));
                }
            }
        }

        let mut outgoing = vec![BTreeSet::new(); self.graph.passes.len()];
        for (index, pass) in self.graph.passes.iter().enumerate() {
            for dependency in pass.dependencies() {
                let dependency_index = self.pass_ids.get(dependency).copied().ok_or_else(|| {
                    GraphValidationError::UnknownDependency {
                        pass: pass.id().into(),
                        dependency: dependency.clone(),
                    }
                })?;
                outgoing[dependency_index].insert(index);
            }
            for input in pass.sampled_inputs() {
                if let TextureRef::Temporary(_) = input {
                    let producer = writers.get(input).copied().ok_or_else(|| match input {
                        TextureRef::Temporary(id) => {
                            GraphValidationError::UnwrittenTemporary(id.clone())
                        }
                        _ => unreachable!(),
                    })?;
                    outgoing[producer].insert(index);
                }
            }
        }
        let edge_count = outgoing.iter().map(BTreeSet::len).sum::<usize>();
        check_quota(
            "dependency edges",
            edge_count as u64,
            self.context.quota.max_dependency_edges as u64,
        )?;

        let mut incoming = vec![0_u32; outgoing.len()];
        for targets in &outgoing {
            for target in targets {
                incoming[*target] += 1;
            }
        }
        let mut ready = incoming
            .iter()
            .enumerate()
            .filter_map(|(index, count)| (*count == 0).then_some(index))
            .collect::<BTreeSet<_>>();
        let mut order = Vec::with_capacity(outgoing.len());
        while let Some(index) = ready.pop_first() {
            order.push(index);
            for target in &outgoing[index] {
                incoming[*target] -= 1;
                if incoming[*target] == 0 {
                    ready.insert(*target);
                }
            }
        }
        if order.len() != outgoing.len() {
            return Err(GraphValidationError::DependencyCycle);
        }
        Ok((order, edge_count as u32, writers))
    }

    fn ensure_all_outputs_written(
        &self,
        writers: &BTreeMap<TextureRef, usize>,
    ) -> Result<(), GraphValidationError> {
        for texture in self.texture_sizes.keys() {
            if !writers.contains_key(&TextureRef::Temporary(texture.clone())) {
                return Err(GraphValidationError::UnwrittenTemporary(texture.clone()));
            }
        }
        if !writers.contains_key(&TextureRef::Output) {
            return Err(GraphValidationError::UnwrittenOutput);
        }
        Ok(())
    }

    fn validate_dispatches(&self) -> Result<BTreeMap<String, [u32; 3]>, GraphValidationError> {
        let mut dispatches = BTreeMap::new();
        let mut total = 0_u64;
        for pass in &self.graph.passes {
            let GraphPass::Compute { id, dispatch, .. } = pass else {
                continue;
            };
            let workgroups = match dispatch {
                ComputeDispatch::ForTexture {
                    texture,
                    workgroup_size,
                } => {
                    if !valid_workgroup_size(*workgroup_size) {
                        return Err(GraphValidationError::InvalidWorkgroupSize {
                            pass: id.clone(),
                        });
                    }
                    let [width, height] = self.texture_size(texture)?;
                    [
                        width.div_ceil(workgroup_size[0]),
                        height.div_ceil(workgroup_size[1]),
                        1,
                    ]
                }
                ComputeDispatch::Fixed { workgroups } => *workgroups,
            };
            if workgroups.contains(&0) || workgroups.into_iter().any(|axis| axis > 65_535) {
                return Err(GraphValidationError::InvalidDispatchSize { pass: id.clone() });
            }
            let count = workgroups.into_iter().map(u64::from).product::<u64>();
            check_quota(
                "workgroups per pass",
                count,
                self.context.quota.max_workgroups_per_pass,
            )?;
            total = total
                .checked_add(count)
                .ok_or(GraphValidationError::QuotaExceeded {
                    resource: "total workgroups",
                    actual: u64::MAX,
                    limit: self.context.quota.max_total_workgroups,
                })?;
            dispatches.insert(id.clone(), workgroups);
        }
        check_quota(
            "total workgroups",
            total,
            self.context.quota.max_total_workgroups,
        )?;
        Ok(dispatches)
    }

    fn texture_size(&self, texture: &TextureRef) -> Result<[u32; 2], GraphValidationError> {
        match texture {
            TextureRef::Source | TextureRef::Output => {
                Ok([self.context.output_width, self.context.output_height])
            }
            TextureRef::Temporary(id) => self
                .texture_sizes
                .get(id)
                .copied()
                .ok_or_else(|| GraphValidationError::UndeclaredTexture(texture.clone())),
        }
    }
}

impl TextureExtent {
    fn resolve(
        self,
        output_width: u32,
        output_height: u32,
        id: &str,
    ) -> Result<[u32; 2], GraphValidationError> {
        let size = match self {
            Self::FullFrame => [output_width, output_height],
            Self::Scale {
                numerator,
                denominator,
            } => {
                if numerator == 0 || denominator == 0 {
                    return Err(GraphValidationError::InvalidTextureExtent(id.into()));
                }
                [
                    output_width.saturating_mul(numerator).div_ceil(denominator),
                    output_height
                        .saturating_mul(numerator)
                        .div_ceil(denominator),
                ]
            }
            Self::Fixed { width, height } => [width, height],
        };
        if size.contains(&0) {
            return Err(GraphValidationError::InvalidTextureExtent(id.into()));
        }
        Ok(size)
    }
}

fn validate_identifier(id: &str) -> Result<(), GraphValidationError> {
    if valid_identifier(id) {
        Ok(())
    } else {
        Err(GraphValidationError::InvalidIdentifier(id.into()))
    }
}

fn valid_identifier(id: &str) -> bool {
    let mut characters = id.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && id.len() <= 64
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn valid_workgroup_size(size: [u32; 3]) -> bool {
    !size.contains(&0)
        && size[0] <= 256
        && size[1] <= 256
        && size[2] <= 64
        && size.into_iter().product::<u32>() <= 256
}

fn check_quota(
    resource: &'static str,
    actual: u64,
    limit: u64,
) -> Result<(), GraphValidationError> {
    if actual > limit {
        Err(GraphValidationError::QuotaExceeded {
            resource,
            actual,
            limit,
        })
    } else {
        Ok(())
    }
}

/// Reference graphs that exercise the complete MVP API without granting native capabilities.
pub mod examples;

#[cfg(test)]
mod tests;
