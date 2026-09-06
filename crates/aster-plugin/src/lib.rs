//! Versioned manifest and parameter ABI for portable WGSL effects.

mod abi;
mod error;
pub mod generator;
mod generator_shader;
pub mod graph;
pub mod hot_reload;
pub mod registry;

pub use abi::{EFFECT_ENTRY_POINT, EFFECT_PARAMETER_VECTORS, EFFECT_UNIFORM_SIZE};
pub use error::PluginError;
pub use generator_shader::validate_scene_generator_sources;
mod package;
mod repository;
pub use package::{PluginLimits, PluginPackage};
pub use repository::PluginRepository;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub plugin: PluginMetadata,
    #[serde(default)]
    pub capabilities: BTreeSet<Capability>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    #[serde(default)]
    pub scene_generator: Option<generator::SceneGeneratorGraph>,
}

impl PluginManifest {
    pub const HOST_API_VERSION: u32 = 1;
    pub fn validate(&self) -> Result<(), PluginError> {
        if !PluginMetadata::valid_plugin_id(&self.plugin.id) {
            return Err(PluginError::InvalidId(self.plugin.id.clone()));
        }
        if !PluginMetadata::valid_display_text(&self.plugin.name, 256) {
            return Err(PluginError::InvalidName(self.plugin.name.clone()));
        }
        if self.plugin.api_version != Self::HOST_API_VERSION {
            return Err(PluginError::UnsupportedApi(self.plugin.api_version));
        }
        if !PluginMetadata::valid_version(&self.plugin.version) {
            return Err(PluginError::InvalidVersion(self.plugin.version.clone()));
        }
        if !PluginMetadata::valid_shader_path(&self.plugin.shader) {
            return Err(PluginError::InvalidShaderPath(self.plugin.shader.clone()));
        }
        let parameter_limit = match self.plugin.kind {
            PluginKind::Effect => EFFECT_PARAMETER_VECTORS as usize,
            PluginKind::SceneGenerator => generator::MAX_GENERATOR_PARAMETERS,
        };
        if self.parameters.len() > parameter_limit {
            return Err(PluginError::TooManyParameters {
                actual: self.parameters.len(),
                limit: parameter_limit,
            });
        }
        let mut names = BTreeSet::new();
        for parameter in &self.parameters {
            if !names.insert(parameter.name()) {
                return Err(PluginError::DuplicateParameter(parameter.name().into()));
            }
            parameter.validate()?;
        }
        match (&self.plugin.kind, &self.scene_generator) {
            (PluginKind::Effect, None) => {
                if self
                    .parameters
                    .iter()
                    .any(|parameter| matches!(parameter, Parameter::Vector { .. }))
                {
                    return Err(PluginError::UnsupportedParameterForKind("vector"));
                }
            }
            (PluginKind::Effect, Some(_)) => return Err(PluginError::UnexpectedSceneGenerator),
            (PluginKind::SceneGenerator, Some(graph)) => {
                if self
                    .parameters
                    .iter()
                    .any(|parameter| matches!(parameter, Parameter::Texture { .. }))
                {
                    return Err(PluginError::UnsupportedParameterForKind("texture"));
                }
                graph.validate()?;
                if !self.capabilities.contains(&Capability::GpuCompute)
                    || !self.capabilities.contains(&Capability::GpuRender)
                {
                    return Err(PluginError::MissingGeneratorCapabilities);
                }
                match self
                    .parameters
                    .iter()
                    .find(|parameter| parameter.name() == graph.capacity_parameter)
                {
                    Some(Parameter::Number { .. }) => {}
                    Some(_) => {
                        return Err(PluginError::InvalidGeneratorParameterRole {
                            parameter: graph.capacity_parameter.clone(),
                            expected: "number",
                        });
                    }
                    None => {
                        return Err(PluginError::MissingCapacityParameter(
                            graph.capacity_parameter.clone(),
                        ));
                    }
                }
                if let Some(render_parameter) = &graph.render_parameter {
                    match self
                        .parameters
                        .iter()
                        .find(|parameter| parameter.name() == render_parameter)
                    {
                        Some(Parameter::Choice { choices, .. }) => {
                            if graph.render_variants.iter().any(|variant| {
                                variant
                                    .selector_value
                                    .as_ref()
                                    .is_none_or(|selector| !choices.contains(selector))
                            }) {
                                return Err(PluginError::InvalidRenderSelectorChoice(
                                    render_parameter.clone(),
                                ));
                            }
                        }
                        Some(_) => {
                            return Err(PluginError::InvalidGeneratorParameterRole {
                                parameter: render_parameter.clone(),
                                expected: "choice",
                            });
                        }
                        None => {
                            return Err(PluginError::MissingRenderParameter(
                                render_parameter.clone(),
                            ));
                        }
                    }
                }
                if !graph.shader_paths().contains(self.plugin.shader.as_str()) {
                    return Err(PluginError::PrimaryShaderNotDeclared(
                        self.plugin.shader.clone(),
                    ));
                }
            }
            (PluginKind::SceneGenerator, None) => return Err(PluginError::MissingSceneGenerator),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub shader: String,
    #[serde(default)]
    pub kind: PluginKind,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    #[default]
    Effect,
    SceneGenerator,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    GpuCompute,
    GpuRender,
    FileRead,
    Network,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Parameter {
    Number {
        name: String,
        label: String,
        default: f32,
        min: f32,
        max: f32,
    },
    Color {
        name: String,
        label: String,
        default: [f32; 4],
    },
    Vector {
        name: String,
        label: String,
        default: Vec<f32>,
        min: f32,
        max: f32,
    },
    Choice {
        name: String,
        label: String,
        default: String,
        choices: Vec<String>,
    },
    Texture {
        name: String,
        label: String,
    },
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DiscoveryReport {
    pub plugins: Vec<PluginManifest>,
    pub failures: Vec<PluginLoadFailure>,
    pub shader_sources: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginLoadFailure {
    pub manifest: PathBuf,
    pub message: String,
}

impl Parameter {
    pub fn name(&self) -> &str {
        match self {
            Self::Number { name, .. }
            | Self::Color { name, .. }
            | Self::Vector { name, .. }
            | Self::Choice { name, .. }
            | Self::Texture { name, .. } => name,
        }
    }

    fn validate(&self) -> Result<(), PluginError> {
        if !Parameter::valid_parameter_name(self.name()) {
            return Err(PluginError::InvalidParameter(self.name().into()));
        }
        let label = match self {
            Self::Number { label, .. }
            | Self::Color { label, .. }
            | Self::Vector { label, .. }
            | Self::Choice { label, .. }
            | Self::Texture { label, .. } => label,
        };
        if !PluginMetadata::valid_display_text(label, 256) {
            return Err(PluginError::InvalidParameter(self.name().into()));
        }
        match self {
            Self::Number {
                name,
                default,
                min,
                max,
                ..
            } if !min.is_finite()
                || !max.is_finite()
                || !default.is_finite()
                || min > max
                || default < min
                || default > max =>
            {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            Self::Color { name, default, .. }
                if default
                    .iter()
                    .any(|channel| !channel.is_finite() || !(0.0..=1.0).contains(channel)) =>
            {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            Self::Vector {
                name,
                default,
                min,
                max,
                ..
            } if default.len() < 2
                || default.len() > 4
                || !min.is_finite()
                || !max.is_finite()
                || min > max
                || default
                    .iter()
                    .any(|channel| !channel.is_finite() || channel < min || channel > max) =>
            {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            Self::Choice {
                name,
                default,
                choices,
                ..
            } if choices.is_empty()
                || choices.len() > 256
                || !choices.contains(default)
                || choices
                    .iter()
                    .any(|choice| !PluginMetadata::valid_display_text(choice, 128))
                || choices.iter().collect::<BTreeSet<_>>().len() != choices.len() =>
            {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            _ => Ok(()),
        }
    }
}

impl Parameter {
    pub(crate) fn valid_parameter_name(name: &str) -> bool {
        let mut characters = name.chars();
        name.len() <= 128
            && characters
                .next()
                .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
            && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
    }
}

impl PluginMetadata {
    pub fn valid_plugin_id(id: &str) -> bool {
        id.len() <= 128
            && id.split('.').count() >= 2
            && id.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            })
    }
}

impl PluginMetadata {
    pub(crate) fn valid_version(version: &str) -> bool {
        let parts = version.split('.').collect::<Vec<_>>();
        version.len() <= 64
            && parts.len() == 3
            && parts.iter().all(|part| {
                !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
            })
    }
}

impl PluginMetadata {
    pub(crate) fn valid_display_text(value: &str, maximum: usize) -> bool {
        !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
    }
}

impl PluginMetadata {
    pub(crate) fn valid_shader_path(shader: &str) -> bool {
        let path = Path::new(shader);
        path.extension().and_then(|extension| extension.to_str()) == Some("wgsl")
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
    }
}

impl PluginMetadata {
    pub(crate) fn validate_external_id(id: &str) -> Result<(), PluginError> {
        if id.starts_with("org.aster.builtin.") {
            return Err(PluginError::ReservedId(id.to_owned()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
