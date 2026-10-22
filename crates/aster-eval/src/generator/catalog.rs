use super::{GeneratorDefinition, GeneratorProgramSource, NativeGeneratorProgram};
use crate::{BundleLimits, BundleResources, EvaluationError};
use aster_plugin::generator::GeneratorLimits;
use aster_render_ir::{ResourceHash, VerifiedResource};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct GeneratorCatalog {
    pub(crate) entries: BTreeMap<(String, String), AdmittedGenerator>,
    pub(crate) limits: GeneratorLimits,
    pub(crate) unavailable: BTreeMap<(String, String), UnavailableGeneratorReason>,
    max_entries: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UnavailableGenerator {
    pub plugin_id: String,
    pub node_type: String,
    pub reason: UnavailableGeneratorReason,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableGeneratorReason {
    SafeMode,
    Disabled,
    Missing,
}
#[derive(Clone)]
pub(crate) struct AdmittedGenerator {
    pub definition: GeneratorDefinition,
    pub program: NativeGeneratorProgram,
}
impl GeneratorCatalog {
    pub fn compile(
        sources: Vec<(GeneratorDefinition, GeneratorProgramSource)>,
        limits: GeneratorLimits,
        budget: BundleLimits,
    ) -> Result<Self, EvaluationError> {
        if sources.len() > budget.max_bundle_resources {
            return Err(EvaluationError::InvalidScene(
                "generator catalog entry budget".into(),
            ));
        }
        let max_entries = budget.max_bundle_resources;
        let mut resources = BundleResources::new(budget)?;
        let mut shared: BTreeMap<ResourceHash, VerifiedResource> = BTreeMap::new();
        let mut entries = BTreeMap::new();
        for (definition, source) in sources {
            let key = (definition.plugin_id.clone(), definition.node_type.clone());
            if entries.contains_key(&key) {
                return Err(EvaluationError::InvalidScene(
                    "duplicate generator definition".into(),
                ));
            }
            let mut program = NativeGeneratorProgram::compile(&definition, &source, &limits)?;
            for shader in &mut program.shaders {
                let hash = resources.add(shader.clone())?;
                if let Some(existing) = shared.get(&hash) {
                    *shader = existing.clone();
                } else {
                    shared.insert(hash, shader.clone());
                }
            }
            entries.insert(
                key,
                AdmittedGenerator {
                    definition,
                    program,
                },
            );
        }
        Ok(Self {
            entries,
            limits,
            unavailable: BTreeMap::new(),
            max_entries,
        })
    }

    /// Omission is allowed only for identities explicitly classified by the trusted plugin host.
    pub fn with_unavailable(
        mut self,
        unavailable: Vec<UnavailableGenerator>,
    ) -> Result<Self, EvaluationError> {
        if !self.unavailable.is_empty()
            || self.entries.len().saturating_add(unavailable.len()) > self.max_entries
        {
            return Err(EvaluationError::InvalidScene(
                "unavailable generator catalog budget or repeated admission".into(),
            ));
        }
        for item in unavailable {
            let identity = (item.plugin_id, item.node_type);
            if !aster_plugin::PluginMetadata::valid_plugin_id(&identity.0)
                || identity.0 == "org.aster.builtin"
                || identity.0.starts_with("org.aster.builtin.")
                || identity.1.is_empty()
                || identity.1.len() > 256
                || identity.1.chars().any(char::is_control)
                || self.entries.contains_key(&identity)
                || self.unavailable.insert(identity, item.reason).is_some()
            {
                return Err(EvaluationError::InvalidScene(
                    "invalid, duplicate or admitted unavailable generator".into(),
                ));
            }
        }
        Ok(self)
    }
}
