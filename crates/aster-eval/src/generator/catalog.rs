use super::{GeneratorDefinition, GeneratorProgramSource, NativeGeneratorProgram};
use crate::{BundleLimits, BundleResources, EvaluationError};
use aster_plugin::generator::GeneratorLimits;
use aster_render_ir::{ResourceHash, VerifiedResource};
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct GeneratorCatalog {
    pub(crate) entries: BTreeMap<(String, String), AdmittedGenerator>,
    pub(crate) limits: GeneratorLimits,
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
        Ok(Self { entries, limits })
    }
}
