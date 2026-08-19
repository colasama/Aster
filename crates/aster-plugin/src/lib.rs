//! Versioned manifest and parameter ABI for portable WGSL effects.

use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

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
            Self::Choice {
                name,
                default,
                choices,
                ..
            } if choices.is_empty() || !choices.contains(default) => {
                Err(PluginError::InvalidParameter(name.clone()))
            }
            _ => Ok(()),
        }
    }
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
    #[error("parameter `{0}` is invalid")]
    InvalidParameter(String),
    #[error("parameter `{0}` is declared more than once")]
    DuplicateParameter(String),
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

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
        fs::write(valid.join("effect.wgsl"), "@fragment fn main() {}").unwrap();
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
}
