//! Versioned manifest and parameter ABI for portable WGSL effects.

mod abi;

pub use abi::{EFFECT_ENTRY_POINT, EFFECT_PARAMETER_VECTORS, EFFECT_UNIFORM_SIZE};

use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_SHADER_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub plugin: PluginMetadata,
    #[serde(default)]
    pub capabilities: BTreeSet<Capability>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
}

impl PluginManifest {
    pub fn parse(source: &str) -> Result<Self, PluginError> {
        let manifest: Self = toml::from_str(source)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), PluginError> {
        if !valid_id(&self.plugin.id) {
            return Err(PluginError::InvalidId(self.plugin.id.clone()));
        }
        if self.plugin.api_version != 1 {
            return Err(PluginError::UnsupportedApi(self.plugin.api_version));
        }
        if !valid_version(&self.plugin.version) {
            return Err(PluginError::InvalidVersion(self.plugin.version.clone()));
        }
        if !valid_shader_path(&self.plugin.shader) {
            return Err(PluginError::InvalidShaderPath(self.plugin.shader.clone()));
        }
        if self.parameters.len() > EFFECT_PARAMETER_VECTORS as usize {
            return Err(PluginError::TooManyParameters(self.parameters.len()));
        }
        let mut names = BTreeSet::new();
        for parameter in &self.parameters {
            if !names.insert(parameter.name()) {
                return Err(PluginError::DuplicateParameter(parameter.name().into()));
            }
            parameter.validate()?;
        }
        Ok(())
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, PluginError> {
        let path = path.as_ref();
        let manifest = Self::parse(&fs::read_to_string(path)?)?;
        let directory = path.parent().unwrap_or_else(|| Path::new("."));
        let shader = directory.join(&manifest.plugin.shader);
        if !shader.is_file() {
            return Err(PluginError::MissingShader(shader));
        }
        let metadata = fs::metadata(&shader)?;
        if metadata.len() > MAX_SHADER_BYTES {
            return Err(PluginError::ShaderTooLarge(metadata.len()));
        }
        validate_shader(&fs::read_to_string(shader)?)?;
        Ok(manifest)
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
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginLoadFailure {
    pub manifest: PathBuf,
    pub message: String,
}

pub fn discover(root: impl AsRef<Path>) -> Result<DiscoveryReport, PluginError> {
    let root = root.as_ref();
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
    for manifest in manifests {
        match PluginManifest::load(&manifest) {
            Ok(plugin) => report.plugins.push(plugin),
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
/// Only the manifest and its declared shader are copied. This keeps the v1 plugin surface
/// capability-bounded and prevents undeclared native payloads from entering the plugin directory.
pub fn install(
    source: impl AsRef<Path>,
    root: impl AsRef<Path>,
) -> Result<PluginManifest, PluginError> {
    let source = source.as_ref().canonicalize()?;
    let manifest_path = source.join("plugin.toml");
    let manifest = PluginManifest::load(&manifest_path)?;
    let shader_source = source.join(&manifest.plugin.shader).canonicalize()?;
    if !shader_source.starts_with(&source) {
        return Err(PluginError::ShaderOutsidePlugin(shader_source));
    }

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
    let shader_destination = staging.join(&manifest.plugin.shader);
    if let Some(parent) = shader_destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(shader_source, shader_destination)?;
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

fn validate_shader(source: &str) -> Result<(), PluginError> {
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

impl Parameter {
    pub fn name(&self) -> &str {
        match self {
            Self::Number { name, .. }
            | Self::Color { name, .. }
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
            | Self::Choice { label, .. }
            | Self::Texture { label, .. } => label,
        };
        if label.trim().is_empty() {
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
            Self::Choice {
                name,
                default,
                choices,
                ..
            } if choices.is_empty()
                || !choices.contains(default)
                || choices.iter().any(|choice| choice.trim().is_empty())
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
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.split('.').count() >= 2
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || ".-_".contains(character)
        })
}

fn valid_version(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn valid_shader_path(shader: &str) -> bool {
    let path = Path::new(shader);
    path.extension().and_then(|extension| extension.to_str()) == Some("wgsl")
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin manifest I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin manifest is invalid TOML: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("plugin id `{0}` must be a reverse-domain identifier")]
    InvalidId(String),
    #[error("plugin API version {0} is not supported")]
    UnsupportedApi(u32),
    #[error("plugin version `{0}` must use major.minor.patch numeric form")]
    InvalidVersion(String),
    #[error("plugin shader path `{0}` must be a relative .wgsl path")]
    InvalidShaderPath(String),
    #[error("plugin shader was not found at {0}")]
    MissingShader(PathBuf),
    #[error("plugin shader is {0} bytes; the v1 limit is 4194304 bytes")]
    ShaderTooLarge(u64),
    #[error("plugin shader resolves outside its plugin directory: {0}")]
    ShaderOutsidePlugin(PathBuf),
    #[error("plugin shader WGSL could not be parsed: {0}")]
    ShaderParse(String),
    #[error("plugin shader WGSL failed validation: {0}")]
    ShaderValidation(String),
    #[error("plugin shader does not implement Aster effect ABI v1: {0}")]
    ShaderAbi(String),
    #[error("parameter `{0}` is invalid")]
    InvalidParameter(String),
    #[error("parameter `{0}` is declared more than once")]
    DuplicateParameter(String),
    #[error("effect declares {0} parameters; ABI v1 supports at most 16")]
    TooManyParameters(usize),
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const VALID_EFFECT: &str = r#"
struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}

@group(0) @binding(0) var aster_source: texture_2d<f32>;
@group(0) @binding(1) var aster_sampler: sampler;
@group(0) @binding(2) var<uniform> aster: AsterEffectUniforms;

@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f {
    let source = textureSample(aster_source, aster_sampler, uv);
    return vec4f(source.rgb * aster.parameters[0].x, source.a);
}
"#;

    #[test]
    fn parses_wgsl_effect_manifest() {
        let manifest = PluginManifest::parse(
            r#"
                [plugin]
                id = "org.aster.tint"
                name = "Tint"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "number"
                name = "amount"
                label = "Amount"
                default = 1.0
                min = 0.0
                max = 1.0
            "#,
        )
        .unwrap();
        assert_eq!(manifest.plugin.id, "org.aster.tint");
        assert_eq!(manifest.parameters.len(), 1);
    }

    #[test]
    fn validates_parameter_schema_before_exposing_it_to_the_host() {
        let invalid_color = PluginManifest::parse(
            r#"
                [plugin]
                id = "org.aster.invalid-color"
                name = "Invalid Color"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "color"
                name = "tint"
                label = "Tint"
                default = [1.2, 0.5, 0.5, 1.0]
            "#,
        )
        .unwrap_err();
        assert!(matches!(invalid_color, PluginError::InvalidParameter(name) if name == "tint"));

        let invalid_name = PluginManifest::parse(
            r#"
                [plugin]
                id = "org.aster.invalid-name"
                name = "Invalid Name"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "texture"
                name = "source texture"
                label = "Source"
            "#,
        )
        .unwrap_err();
        assert!(
            matches!(invalid_name, PluginError::InvalidParameter(name) if name == "source texture")
        );
    }

    #[test]
    fn discovers_valid_plugins_and_reports_isolated_failures() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("aster-plugin-{nonce}"));
        let valid = root.join("valid");
        let invalid = root.join("invalid");
        fs::create_dir_all(&valid).unwrap();
        fs::create_dir_all(&invalid).unwrap();
        fs::write(
            valid.join("plugin.toml"),
            r#"
                capabilities = ["gpu_render"]

                [plugin]
                id = "org.aster.valid"
                name = "Valid"
                version = "1.2.3"
                api_version = 1
                shader = "effect.wgsl"
            "#,
        )
        .unwrap();
        fs::write(valid.join("effect.wgsl"), VALID_EFFECT).unwrap();
        fs::write(
            invalid.join("plugin.toml"),
            r#"
                [plugin]
                id = "org.aster.invalid"
                name = "Invalid"
                version = "latest"
                api_version = 1
                shader = "../escape.wgsl"
            "#,
        )
        .unwrap();

        let report = discover(&root).unwrap();
        assert_eq!(report.plugins.len(), 1);
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].message.contains("version"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installs_only_declared_plugin_files_and_replaces_versions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("aster-plugin-install-{nonce}"));
        let source = base.join("source");
        let installed = base.join("installed");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("plugin.toml"),
            r#"
                [plugin]
                id = "org.aster.install"
                name = "Install Test"
                version = "1.0.0"
                api_version = 1
                shader = "shaders/effect.wgsl"
            "#,
        )
        .unwrap();
        fs::create_dir_all(source.join("shaders")).unwrap();
        fs::write(source.join("shaders/effect.wgsl"), VALID_EFFECT).unwrap();
        fs::write(source.join("undeclared.dll"), "not copied").unwrap();

        let manifest = install(&source, &installed).unwrap();
        let destination = installed.join("org.aster.install");
        assert_eq!(manifest.plugin.version, "1.0.0");
        assert!(destination.join("plugin.toml").is_file());
        assert!(destination.join("shaders/effect.wgsl").is_file());
        assert!(!destination.join("undeclared.dll").exists());

        let next_manifest = fs::read_to_string(source.join("plugin.toml"))
            .unwrap()
            .replace("1.0.0", "1.1.0");
        fs::write(source.join("plugin.toml"), next_manifest).unwrap();
        assert_eq!(
            install(&source, &installed).unwrap().plugin.version,
            "1.1.0"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_valid_wgsl_with_an_incompatible_effect_interface() {
        let error =
            validate_shader("@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }")
                .unwrap_err();
        assert!(matches!(error, PluginError::ShaderAbi(_)));
        assert!(error.to_string().contains("aster_effect"));
    }

    #[test]
    fn bundled_effect_examples_implement_the_v1_abi() {
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins");
        for name in ["tint", "chromatic-aberration", "crt"] {
            PluginManifest::load(examples.join(name).join("plugin.toml"))
                .unwrap_or_else(|error| panic!("{name} example failed: {error}"));
        }
    }
}
