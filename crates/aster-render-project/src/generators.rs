use crate::ProjectRenderError;
use aster_eval::{BundleLimits, GeneratorCatalog, GeneratorDefinition, GeneratorProgramSource};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledContract {
    definition: GeneratorDefinition,
    plugin_name: String,
    runtime_key: String,
    shaders: Vec<Shader>,
}
#[derive(Deserialize)]
struct Shader {
    path: String,
    id: String,
    sha256: String,
}

pub struct NativeProjectGenerators;
impl NativeProjectGenerators {
    /// Installed definitions must already have passed the native plugin admission boundary.
    pub fn catalog(
        mut installed: Vec<(GeneratorDefinition, GeneratorProgramSource)>,
        budget: BundleLimits,
    ) -> Result<GeneratorCatalog, ProjectRenderError> {
        let contract: BundledContract =
            serde_json::from_str(include_str!("bundled-particles.json"))?;
        let shaders = aster_shaders::ShaderCatalog::embedded()
            .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
        let mut sources = BTreeMap::new();
        for shader in contract.shaders {
            let program = shaders
                .program(&shader.id)
                .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
            if format!("{:x}", Sha256::digest(program.source.as_bytes())) != shader.sha256 {
                return Err(ProjectRenderError::Invalid(
                    "bundled generator shader differs from its contract".into(),
                ));
            }
            sources.insert(shader.path, program.source.clone());
        }
        installed.push((
            contract.definition,
            GeneratorProgramSource {
                plugin_name: contract.plugin_name,
                runtime_key: contract.runtime_key,
                shader_sources: sources,
            },
        ));
        Ok(GeneratorCatalog::compile(
            installed,
            Default::default(),
            budget,
        )?)
    }
}
