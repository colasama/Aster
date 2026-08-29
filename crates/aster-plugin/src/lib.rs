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

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const MAX_SHADER_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PLUGIN_SHADER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const HOST_PLUGIN_API_VERSION: u32 = 1;

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
    pub fn parse(source: &str) -> Result<Self, PluginError> {
        if source.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(PluginError::ManifestTooLarge(source.len() as u64));
        }
        let manifest: Self = toml::from_str(source)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), PluginError> {
        if !valid_plugin_id(&self.plugin.id) {
            return Err(PluginError::InvalidId(self.plugin.id.clone()));
        }
        if !valid_display_text(&self.plugin.name, 256) {
            return Err(PluginError::InvalidName(self.plugin.name.clone()));
        }
        if self.plugin.api_version != HOST_PLUGIN_API_VERSION {
            return Err(PluginError::UnsupportedApi(self.plugin.api_version));
        }
        if !valid_version(&self.plugin.version) {
            return Err(PluginError::InvalidVersion(self.plugin.version.clone()));
        }
        if !valid_shader_path(&self.plugin.shader) {
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

    pub fn load(path: impl AsRef<Path>) -> Result<Self, PluginError> {
        let path = path.as_ref();
        let manifest = Self::load_metadata(path)?;
        let directory = path.parent().unwrap_or_else(|| Path::new("."));
        let sources = read_shader_sources(directory, &manifest)?;
        validate_shader_sources(&manifest, &sources)?;
        Ok(manifest)
    }

    pub fn load_metadata(path: impl AsRef<Path>) -> Result<Self, PluginError> {
        let path = path.as_ref();
        let manifest_bytes = fs::metadata(path)?.len();
        if manifest_bytes > MAX_MANIFEST_BYTES {
            return Err(PluginError::ManifestTooLarge(manifest_bytes));
        }
        Self::parse(&fs::read_to_string(path)?)
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

pub fn discover(root: impl AsRef<Path>) -> Result<DiscoveryReport, PluginError> {
    discover_with_runtime(root.as_ref(), |_| true)
}

/// Discovers only plugin manifests and preferences-facing metadata.
///
/// Shader files are deliberately not opened or validated here. The desktop shell uses this path
/// to populate the plugin manager without paying the I/O and WGSL validation cost for plugins the
/// current project never activates.
pub fn discover_metadata(root: impl AsRef<Path>) -> Result<DiscoveryReport, PluginError> {
    discover_with_runtime(root.as_ref(), |_| false)
}

/// Discovers every manifest while loading runtime shader sources only for selected plugin IDs.
pub fn discover_selected(
    root: impl AsRef<Path>,
    plugin_ids: &BTreeSet<String>,
) -> Result<DiscoveryReport, PluginError> {
    discover_with_runtime(root.as_ref(), |plugin_id| plugin_ids.contains(plugin_id))
}

fn discover_with_runtime(
    root: &Path,
    should_load_runtime: impl Fn(&str) -> bool,
) -> Result<DiscoveryReport, PluginError> {
    if !root.exists() {
        return Ok(DiscoveryReport::default());
    }
    let mut manifests = Vec::new();
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        let candidate = if path.is_dir() {
            path.join("plugin.toml")
        } else {
            path
        };
        if candidate.file_name().and_then(|name| name.to_str()) == Some("plugin.toml") {
            manifests.push(candidate);
        }
    }
    manifests.sort();
    let mut report = DiscoveryReport::default();
    let mut ids = BTreeSet::new();
    for manifest in manifests {
        match PluginManifest::load_metadata(&manifest) {
            Ok(plugin) => {
                if let Err(error) = validate_third_party_id(&plugin.plugin.id) {
                    report.failures.push(PluginLoadFailure {
                        manifest,
                        message: error.to_string(),
                    });
                    continue;
                }
                if !ids.insert(plugin.plugin.id.clone()) {
                    report.failures.push(PluginLoadFailure {
                        manifest,
                        message: PluginError::DuplicatePluginId(plugin.plugin.id).to_string(),
                    });
                    continue;
                }
                if should_load_runtime(&plugin.plugin.id) {
                    let directory = manifest.parent().unwrap_or_else(|| Path::new("."));
                    match read_shader_sources(directory, &plugin) {
                        Ok(sources) => {
                            if let Err(error) = validate_shader_sources(&plugin, &sources) {
                                report.failures.push(PluginLoadFailure {
                                    manifest,
                                    message: error.to_string(),
                                });
                                continue;
                            }
                            report
                                .shader_sources
                                .insert(plugin.plugin.id.clone(), sources);
                            report.plugins.push(plugin);
                        }
                        Err(error) => report.failures.push(PluginLoadFailure {
                            manifest,
                            message: error.to_string(),
                        }),
                    }
                } else {
                    report.plugins.push(plugin);
                }
            }
            Err(error) => report.failures.push(PluginLoadFailure {
                manifest,
                message: error.to_string(),
            }),
        }
    }
    Ok(report)
}

/// Installs a validated WGSL plugin using a same-volume atomic directory swap.
///
/// Only the manifest and its declared shaders are copied. This keeps the v1 plugin surface
/// capability-bounded and prevents undeclared native payloads from entering the plugin directory.
pub fn install(
    source: impl AsRef<Path>,
    root: impl AsRef<Path>,
) -> Result<PluginManifest, PluginError> {
    let source = source.as_ref().canonicalize()?;
    let manifest_path = source.join("plugin.toml");
    let manifest = PluginManifest::load(&manifest_path)?;
    validate_third_party_id(&manifest.plugin.id)?;
    let shader_paths = declared_shader_paths(&manifest);

    let root = root.as_ref();
    fs::create_dir_all(root)?;
    let destination = root.join(&manifest.plugin.id);
    let nonce = std::process::id();
    let staging = root.join(format!(".{}-{nonce}.installing", manifest.plugin.id));
    let backup = root.join(format!(".{}-{nonce}.backup", manifest.plugin.id));
    remove_directory_if_present(&staging)?;
    remove_directory_if_present(&backup)?;
    fs::create_dir_all(&staging)?;
    fs::copy(&manifest_path, staging.join("plugin.toml"))?;
    for shader_path in shader_paths {
        let shader_source = source.join(shader_path).canonicalize()?;
        if !shader_source.starts_with(&source) {
            return Err(PluginError::ShaderOutsidePlugin(shader_source));
        }
        let shader_destination = staging.join(shader_path);
        if let Some(parent) = shader_destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(shader_source, shader_destination)?;
    }
    PluginManifest::load(staging.join("plugin.toml"))?;

    if destination.exists() {
        fs::rename(&destination, &backup)?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(PluginError::Io(error));
    }
    remove_directory_if_present(&backup)?;
    Ok(manifest)
}

fn remove_directory_if_present(path: &Path) -> Result<(), PluginError> {
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

pub(crate) fn validate_third_party_id(id: &str) -> Result<(), PluginError> {
    if id.starts_with("org.aster.builtin.") {
        return Err(PluginError::ReservedId(id.to_owned()));
    }
    Ok(())
}

fn validate_effect_shader(source: &str) -> Result<(), PluginError> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|error| PluginError::ShaderParse(error.emit_to_string(source)))?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|error| PluginError::ShaderValidation(error.to_string()))?;
    abi::validate_effect_abi(&module).map_err(PluginError::ShaderAbi)
}

pub(crate) fn validate_shader_sources(
    manifest: &PluginManifest,
    sources: &BTreeMap<String, String>,
) -> Result<(), PluginError> {
    match manifest.plugin.kind {
        PluginKind::Effect => validate_effect_shader(
            sources
                .get(&manifest.plugin.shader)
                .expect("primary shader was collected"),
        ),
        PluginKind::SceneGenerator => validate_scene_generator_sources(manifest, sources),
    }
}

fn declared_shader_paths(manifest: &PluginManifest) -> BTreeSet<&str> {
    let mut paths = BTreeSet::from([manifest.plugin.shader.as_str()]);
    if let Some(graph) = &manifest.scene_generator {
        paths.extend(graph.shader_paths());
    }
    paths
}

pub(crate) fn read_shader_sources(
    directory: &Path,
    manifest: &PluginManifest,
) -> Result<BTreeMap<String, String>, PluginError> {
    let resolved_directory = directory.canonicalize()?;
    let mut sources = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for relative in declared_shader_paths(manifest) {
        let shader = directory.join(relative);
        if !shader.is_file() {
            return Err(PluginError::MissingShader(shader));
        }
        let metadata = fs::metadata(&shader)?;
        if metadata.len() > MAX_SHADER_BYTES {
            return Err(PluginError::ShaderTooLarge(metadata.len()));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_PLUGIN_SHADER_BYTES {
            return Err(PluginError::ShaderPackageTooLarge(total_bytes));
        }
        let resolved_shader = shader.canonicalize()?;
        if !resolved_shader.starts_with(&resolved_directory) {
            return Err(PluginError::ShaderOutsidePlugin(resolved_shader));
        }
        sources.insert(relative.to_owned(), fs::read_to_string(resolved_shader)?);
    }
    Ok(sources)
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
        if !valid_parameter_name(self.name()) {
            return Err(PluginError::InvalidParameter(self.name().into()));
        }
        let label = match self {
            Self::Number { label, .. }
            | Self::Color { label, .. }
            | Self::Vector { label, .. }
            | Self::Choice { label, .. }
            | Self::Texture { label, .. } => label,
        };
        if !valid_display_text(label, 256) {
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
                    .any(|choice| !valid_display_text(choice, 128))
                || choices.iter().collect::<BTreeSet<_>>().len() != choices.len() =>
            {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            _ => Ok(()),
        }
    }
}

fn valid_parameter_name(name: &str) -> bool {
    let mut characters = name.chars();
    name.len() <= 128
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

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
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn valid_version(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    version.len() <= 64
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn valid_display_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn valid_shader_path(shader: &str) -> bool {
    let path = Path::new(shader);
    path.extension().and_then(|extension| extension.to_str()) == Some("wgsl")
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests;
