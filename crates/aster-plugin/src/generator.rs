//! Declarative scene-generator graphs executed by the host-owned WebGPU runtime.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::PluginMetadata;

#[derive(Clone, Debug, clap::Args)]
pub struct GeneratorLimits {
    #[arg(long, default_value_t = Self::default().max_generator_compute_passes)]
    pub max_generator_compute_passes: usize,
    #[arg(long, default_value_t = Self::default().max_generator_render_variants)]
    pub max_generator_render_variants: usize,
    #[arg(long, default_value_t = Self::default().max_generator_instances)]
    pub max_generator_instances: u32,
    #[arg(long, default_value_t = Self::default().max_generator_instance_stride)]
    pub max_generator_instance_stride: u32,
    #[arg(long, default_value_t = Self::default().max_generator_storage_bytes)]
    pub max_generator_storage_bytes: u64,
}
impl Default for GeneratorLimits {
    fn default() -> Self {
        Self {
            max_generator_compute_passes: 8,
            max_generator_render_variants: 8,
            max_generator_instances: 1_000_000,
            max_generator_instance_stride: 256,
            max_generator_storage_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneGeneratorGraph {
    pub api_version: u32,
    pub node_type: String,
    pub capacity_parameter: String,
    pub max_instances: u32,
    pub instance_stride: u32,
    #[serde(default)]
    pub render_parameter: Option<String>,
    pub compute_passes: Vec<GeneratorComputePass>,
    pub render_variants: Vec<GeneratorRenderVariant>,
}

impl SceneGeneratorGraph {
    pub const API_VERSION: u32 = 1;
    pub const PARAMETER_VECTORS: usize = 128;
    pub fn validate(&self, limits: &GeneratorLimits) -> Result<(), SceneGeneratorError> {
        if self.api_version != Self::API_VERSION {
            return Err(SceneGeneratorError::UnsupportedApi(self.api_version));
        }
        if !crate::Parameter::valid_parameter_name(&self.node_type) {
            return Err(SceneGeneratorError::InvalidIdentifier(
                self.node_type.clone(),
            ));
        }
        if !crate::Parameter::valid_parameter_name(&self.capacity_parameter) {
            return Err(SceneGeneratorError::InvalidIdentifier(
                self.capacity_parameter.clone(),
            ));
        }
        if self
            .render_parameter
            .as_deref()
            .is_some_and(|parameter| !crate::Parameter::valid_parameter_name(parameter))
        {
            return Err(SceneGeneratorError::InvalidIdentifier(
                self.render_parameter.clone().unwrap_or_default(),
            ));
        }
        if self.max_instances == 0 || self.max_instances > limits.max_generator_instances {
            return Err(SceneGeneratorError::QuotaExceeded {
                resource: "instances",
                actual: u64::from(self.max_instances),
                limit: u64::from(limits.max_generator_instances),
            });
        }
        if self.instance_stride == 0
            || !self.instance_stride.is_multiple_of(16)
            || self.instance_stride > limits.max_generator_instance_stride
        {
            return Err(SceneGeneratorError::InvalidInstanceStride(
                self.instance_stride,
            ));
        }
        let storage_bytes = u64::from(self.max_instances) * u64::from(self.instance_stride);
        if storage_bytes > limits.max_generator_storage_bytes {
            return Err(SceneGeneratorError::QuotaExceeded {
                resource: "storage bytes",
                actual: storage_bytes,
                limit: limits.max_generator_storage_bytes,
            });
        }
        if self.compute_passes.is_empty()
            || self.compute_passes.len() > limits.max_generator_compute_passes
        {
            return Err(SceneGeneratorError::QuotaExceeded {
                resource: "compute passes",
                actual: self.compute_passes.len() as u64,
                limit: limits.max_generator_compute_passes as u64,
            });
        }
        if self.render_variants.is_empty()
            || self.render_variants.len() > limits.max_generator_render_variants
        {
            return Err(SceneGeneratorError::QuotaExceeded {
                resource: "render variants",
                actual: self.render_variants.len() as u64,
                limit: limits.max_generator_render_variants as u64,
            });
        }
        let mut ids = BTreeSet::new();
        for pass in &self.compute_passes {
            pass.validate()?;
            if !ids.insert(pass.id.as_str()) {
                return Err(SceneGeneratorError::DuplicateIdentifier(pass.id.clone()));
            }
        }
        for variant in &self.render_variants {
            variant.validate()?;
            if !ids.insert(variant.id.as_str()) {
                return Err(SceneGeneratorError::DuplicateIdentifier(variant.id.clone()));
            }
        }
        let compute_shaders = self
            .compute_passes
            .iter()
            .map(|pass| pass.shader.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(path) = self
            .render_variants
            .iter()
            .flat_map(GeneratorRenderVariant::shader_paths)
            .find(|path| compute_shaders.contains(path))
        {
            return Err(SceneGeneratorError::SharedComputeRenderShader(
                path.to_owned(),
            ));
        }
        let selectors = self
            .render_variants
            .iter()
            .filter_map(|variant| variant.selector_value.as_deref())
            .collect::<BTreeSet<_>>();
        let selected = self
            .render_variants
            .iter()
            .filter(|variant| variant.selector_value.is_some())
            .count();
        if (selected == 0) != self.render_parameter.is_none()
            || (selected != 0 && selectors.len() != self.render_variants.len())
        {
            return Err(SceneGeneratorError::InvalidRenderSelectors);
        }
        Ok(())
    }

    #[must_use]
    pub fn shader_paths(&self) -> BTreeSet<&str> {
        self.compute_passes
            .iter()
            .map(|pass| pass.shader.as_str())
            .chain(
                self.render_variants
                    .iter()
                    .flat_map(GeneratorRenderVariant::shader_paths),
            )
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratorComputePass {
    pub id: String,
    pub shader: String,
    pub entry_point: String,
    pub workgroup_size: [u32; 3],
    #[serde(default)]
    pub phase: GeneratorComputePhase,
}

impl GeneratorComputePass {
    fn validate(&self) -> Result<(), SceneGeneratorError> {
        if !crate::Parameter::valid_parameter_name(&self.id) {
            return Err(SceneGeneratorError::InvalidIdentifier(self.id.clone()));
        }
        SceneGeneratorGraph::validate_shader_and_entry(&self.shader, &self.entry_point)?;
        let invocations = self
            .workgroup_size
            .iter()
            .copied()
            .try_fold(1_u32, u32::checked_mul)
            .unwrap_or(u32::MAX);
        if self.workgroup_size.contains(&0) || invocations > 256 || self.workgroup_size[2] > 64 {
            return Err(SceneGeneratorError::InvalidWorkgroupSize(
                self.workgroup_size,
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorComputePhase {
    #[default]
    Simulation,
    PreRender,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratorRenderVariant {
    pub id: String,
    pub shader: String,
    pub vertex_entry: String,
    pub fragment_entry: String,
    pub vertex_count: u32,
    #[serde(default)]
    pub selector_value: Option<String>,
    #[serde(default)]
    pub blend: GeneratorBlendMode,
    #[serde(default)]
    pub depth: GeneratorDepthMode,
    #[serde(default)]
    pub cull: GeneratorCullMode,
    #[serde(default)]
    pub auxiliary: Option<GeneratorAuxiliaryPass>,
}

impl GeneratorRenderVariant {
    fn validate(&self) -> Result<(), SceneGeneratorError> {
        if !crate::Parameter::valid_parameter_name(&self.id) {
            return Err(SceneGeneratorError::InvalidIdentifier(self.id.clone()));
        }
        SceneGeneratorGraph::validate_shader_and_entry(&self.shader, &self.vertex_entry)?;
        if !crate::Parameter::valid_parameter_name(&self.fragment_entry) {
            return Err(SceneGeneratorError::InvalidEntryPoint(
                self.fragment_entry.clone(),
            ));
        }
        if self.vertex_count == 0 || self.vertex_count > 65_535 {
            return Err(SceneGeneratorError::QuotaExceeded {
                resource: "vertices per instance",
                actual: u64::from(self.vertex_count),
                limit: 65_535,
            });
        }
        if let Some(selector) = &self.selector_value
            && (selector.is_empty()
                || selector.len() > 128
                || selector.chars().any(char::is_control))
        {
            return Err(SceneGeneratorError::InvalidRenderSelectors);
        }
        if let Some(auxiliary) = &self.auxiliary {
            auxiliary.validate()?;
        }
        Ok(())
    }

    fn shader_paths(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.shader.as_str())
            .chain(self.auxiliary.iter().map(|pass| pass.shader.as_str()))
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratorAuxiliaryPass {
    pub shader: String,
    pub vertex_entry: String,
    pub fragment_entry: String,
}

impl GeneratorAuxiliaryPass {
    fn validate(&self) -> Result<(), SceneGeneratorError> {
        SceneGeneratorGraph::validate_shader_and_entry(&self.shader, &self.vertex_entry)?;
        if !crate::Parameter::valid_parameter_name(&self.fragment_entry) {
            return Err(SceneGeneratorError::InvalidEntryPoint(
                self.fragment_entry.clone(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorBlendMode {
    Normal,
    #[default]
    Add,
    Multiply,
    Screen,
    Overlay,
    Layer,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorDepthMode {
    #[default]
    None,
    Read,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorCullMode {
    #[default]
    None,
    Front,
    Back,
}

#[derive(Debug, Error, PartialEq)]
pub enum SceneGeneratorError {
    #[error("scene-generator API version {0} is unsupported")]
    UnsupportedApi(u32),
    #[error("scene-generator identifier `{0}` is invalid")]
    InvalidIdentifier(String),
    #[error("scene-generator identifier `{0}` is declared more than once")]
    DuplicateIdentifier(String),
    #[error("scene-generator shader path `{0}` must be a relative .wgsl path")]
    InvalidShaderPath(String),
    #[error("scene-generator entry point `{0}` is invalid")]
    InvalidEntryPoint(String),
    #[error(
        "scene-generator instance stride {0} must be a 16-byte multiple within the configured maximum"
    )]
    InvalidInstanceStride(u32),
    #[error("scene-generator workgroup size {0:?} is invalid")]
    InvalidWorkgroupSize([u32; 3]),
    #[error("scene-generator render selectors must be absent or unique on every variant")]
    InvalidRenderSelectors,
    #[error("scene-generator shader `{0}` cannot be shared by compute and render stages")]
    SharedComputeRenderShader(String),
    #[error("scene-generator declares {actual} {resource}; quota allows {limit}")]
    QuotaExceeded {
        resource: &'static str,
        actual: u64,
        limit: u64,
    },
}

impl SceneGeneratorGraph {
    fn validate_shader_and_entry(shader: &str, entry: &str) -> Result<(), SceneGeneratorError> {
        if !PluginMetadata::valid_shader_path(shader) {
            return Err(SceneGeneratorError::InvalidShaderPath(shader.into()));
        }
        if !crate::Parameter::valid_parameter_name(entry) {
            return Err(SceneGeneratorError::InvalidEntryPoint(entry.into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl SceneGeneratorGraph {
        fn fixture() -> SceneGeneratorGraph {
            SceneGeneratorGraph {
                api_version: 1,
                node_type: "particles".into(),
                capacity_parameter: "count".into(),
                max_instances: 1_000_000,
                instance_stride: 48,
                render_parameter: None,
                compute_passes: vec![GeneratorComputePass {
                    id: "simulate".into(),
                    shader: "compute.wgsl".into(),
                    entry_point: "compute_main".into(),
                    workgroup_size: [256, 1, 1],
                    phase: GeneratorComputePhase::Simulation,
                }],
                render_variants: vec![GeneratorRenderVariant {
                    id: "billboard".into(),
                    shader: "render.wgsl".into(),
                    vertex_entry: "vertex_main".into(),
                    fragment_entry: "fragment_main".into(),
                    vertex_count: 6,
                    selector_value: None,
                    blend: GeneratorBlendMode::Add,
                    depth: GeneratorDepthMode::None,
                    cull: GeneratorCullMode::None,
                    auxiliary: None,
                }],
            }
        }
    }

    #[test]
    fn validates_bounded_graph() -> Result<(), SceneGeneratorError> {
        SceneGeneratorGraph::fixture().validate(&GeneratorLimits::default())?;
        Ok(())
    }

    #[test]
    fn rejects_nonportable_workgroup_depth() {
        let mut graph = SceneGeneratorGraph::fixture();
        graph.compute_passes[0].workgroup_size = [1, 1, 128];
        assert_eq!(
            graph.validate(&GeneratorLimits::default()),
            Err(SceneGeneratorError::InvalidWorkgroupSize([1, 1, 128]))
        );
    }

    #[test]
    fn rejects_oversized_storage() {
        let mut graph = SceneGeneratorGraph::fixture();
        graph.instance_stride = 1024;
        assert!(matches!(
            graph.validate(&GeneratorLimits::default()),
            Err(SceneGeneratorError::InvalidInstanceStride(1024))
        ));
    }

    #[test]
    fn requires_separate_compute_and_render_modules() {
        let mut graph = SceneGeneratorGraph::fixture();
        graph.render_variants[0].shader = "compute.wgsl".into();
        assert_eq!(
            graph.validate(&GeneratorLimits::default()),
            Err(SceneGeneratorError::SharedComputeRenderShader(
                "compute.wgsl".into()
            ))
        );
    }
}
