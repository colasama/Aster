use crate::{NativeProjectGenerators, ProjectRenderError};
use aster_eval::{BundleLimits, GeneratorDefinition, GeneratorProgramSource, TextCollation};
use aster_plugin::{
    Capability, Parameter, PluginKind, PluginLimits, generator::SceneGeneratorGraph,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefinitionIdentity {
    plugin_id: String,
    plugin_name: String,
    plugin_version: String,
    node_type: String,
    api_version: u32,
    parameters: Vec<Parameter>,
    graph: SceneGeneratorGraph,
    shader_sources: BTreeMap<String, String>,
    audio_analysis: bool,
}

impl DefinitionIdentity {
    fn fingerprint(&self, locale: &str) -> Result<String, ProjectRenderError> {
        // The bridge promotes f32 parameters into JSON values before serialization to TS.
        let value = serde_json::to_value(self)?;
        let collation = TextCollation::new(locale)?;
        let mut serialized = String::new();
        Self::write(&value, &collation, &mut serialized)?;
        let (mut first, mut second, mut count) = (0x811c9dc5_u32, 0x9e3779b9_u32, 0_usize);
        for unit in serialized.encode_utf16() {
            first = (first ^ u32::from(unit)).wrapping_mul(0x01000193);
            second = (second ^ u32::from(unit))
                .wrapping_mul(0x85ebca6b)
                .rotate_left(13);
            count += 1;
        }
        Ok(format!("{count:x}-{first:08x}-{second:08x}"))
    }

    fn write(
        value: &Value,
        collation: &TextCollation,
        output: &mut String,
    ) -> Result<(), ProjectRenderError> {
        match value {
            Value::Object(object) => {
                let mut entries = object.iter().collect::<Vec<_>>();
                entries.sort_by(|(a, _), (b, _)| collation.compare(a, b));
                output.push('{');
                for (index, (key, entry)) in entries.into_iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    Self::write(entry, collation, output)?;
                }
                output.push('}');
            }
            Value::Array(array) => {
                output.push('[');
                for (index, entry) in array.iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    Self::write(entry, collation, output)?;
                }
                output.push(']');
            }
            Value::Number(number) => {
                let value = number.as_f64().ok_or_else(|| {
                    ProjectRenderError::Invalid("generator number is not finite".into())
                })?;
                output.push_str(ryu_js::Buffer::new().format(value));
            }
            _ => output.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
}

impl NativeProjectGenerators {
    /// Load only explicitly admitted plugin paths; repository policy selects these paths upstream.
    pub fn load_installed(
        manifests: &[PathBuf],
        locale: &str,
        limits: &PluginLimits,
        budget: &BundleLimits,
    ) -> Result<Vec<(GeneratorDefinition, GeneratorProgramSource)>, ProjectRenderError> {
        if manifests.len() > limits.max_candidates {
            return Err(ProjectRenderError::Invalid(
                "installed generator count exceeds budget".into(),
            ));
        }
        let mut definitions = Vec::new();
        let mut ids = BTreeSet::new();
        let mut retained = 0_usize;
        for path in manifests {
            let package = limits
                .load(path, true)
                .map_err(|e| ProjectRenderError::Invalid(e.to_string()))?;
            if package.manifest.plugin.kind != PluginKind::SceneGenerator
                || !ids.insert(package.manifest.plugin.id.clone())
            {
                return Err(ProjectRenderError::Invalid(
                    "invalid or duplicate installed generator".into(),
                ));
            }
            for source in package.shader_sources.values() {
                retained = retained
                    .checked_add(source.len())
                    .ok_or_else(|| ProjectRenderError::Invalid("generator byte overflow".into()))?;
            }
            if retained > budget.max_bundle_bytes {
                return Err(ProjectRenderError::Invalid(
                    "installed generator shaders exceed budget".into(),
                ));
            }
            let manifest = package.manifest;
            let graph = manifest
                .scene_generator
                .ok_or_else(|| ProjectRenderError::Invalid("generator graph absent".into()))?;
            if graph.shader_paths() != package.shader_sources.keys().map(String::as_str).collect() {
                return Err(ProjectRenderError::Invalid(
                    "installed generator exposes undeclared shaders".into(),
                ));
            }
            let identity = DefinitionIdentity {
                plugin_id: manifest.plugin.id,
                plugin_name: manifest.plugin.name,
                plugin_version: manifest.plugin.version,
                node_type: graph.node_type.clone(),
                api_version: graph.api_version,
                parameters: manifest.parameters,
                graph,
                shader_sources: package.shader_sources,
                audio_analysis: manifest.capabilities.contains(&Capability::AudioAnalysis),
            };
            let runtime_key = identity.fingerprint(locale)?;
            let definition = GeneratorDefinition {
                plugin_id: identity.plugin_id,
                node_type: identity.node_type,
                api_version: identity.api_version,
                parameters: serde_json::from_value(serde_json::to_value(&identity.parameters)?)?,
                graph: identity.graph,
                audio_analysis: identity.audio_analysis,
            };
            definitions.push((
                definition,
                GeneratorProgramSource {
                    plugin_name: identity.plugin_name,
                    runtime_key,
                    shader_sources: identity.shader_sources,
                },
            ));
        }
        Ok(definitions)
    }
}
