use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderManifest {
    pub schema_version: u32,
    pub fragments: BTreeMap<String, String>,
    #[serde(default)]
    pub constants: BTreeMap<String, u32>,
    pub programs: BTreeMap<String, ProgramDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramDefinition {
    pub fragments: Vec<ProgramFragment>,
    pub entry_points: Vec<EntryPoint>,
    pub overrides: BTreeMap<String, OverrideDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ProgramFragment {
    Source(String),
    Constant { constant: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct EntryPoint {
    pub name: String,
    pub stage: ShaderStage,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ShaderStage {
    Vertex,
    Fragment,
    Compute,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OverrideDefinition {
    #[serde(rename = "type")]
    pub value_type: OverrideType,
    pub default: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideType {
    U32,
}

#[derive(Debug, thiserror::Error)]
pub enum ShaderError {
    #[error("Invalid shader manifest: {0}")]
    Manifest(String),
    #[error("Shader program {0} is not registered")]
    UnknownProgram(String),
    #[error("Shader program {program} failed WGSL parsing: {diagnostic}")]
    Parse { program: String, diagnostic: String },
    #[error("Shader program {program} failed Naga validation: {diagnostic}")]
    Validation { program: String, diagnostic: String },
    #[error("Invalid pipeline constant {name}: {diagnostic}")]
    PipelineConstant { name: String, diagnostic: String },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl OverrideDefinition {
    pub(crate) fn validate_value(&self, name: &str, value: f64) -> Result<(), ShaderError> {
        let valid = match self.value_type {
            OverrideType::U32 => {
                value.is_finite()
                    && value.fract() == 0.0
                    && value >= 0.0
                    && value <= f64::from(u32::MAX)
            }
        };
        if valid {
            Ok(())
        } else {
            Err(ShaderError::PipelineConstant {
                name: name.to_owned(),
                diagnostic: "expected an exactly representable unsigned 32-bit integer".to_owned(),
            })
        }
    }
}
