use std::collections::BTreeMap;

use crate::{ProgramDefinition, ProgramFragment, ShaderError, ShaderManifest};

/// Programs become visible only after the entire manifest and all modules validate.
#[derive(Debug)]
pub struct ShaderCatalog {
    pub(crate) programs: BTreeMap<String, ShaderProgram>,
}

#[derive(Debug)]
#[non_exhaustive]
pub struct ShaderProgram {
    pub definition: ProgramDefinition,
    pub source: String,
}

impl ShaderCatalog {
    pub fn from_json(
        manifest: &str,
        sources: BTreeMap<String, String>,
    ) -> Result<Self, ShaderError> {
        let manifest: ShaderManifest = serde_json::from_str(manifest)?;
        manifest.validate(&sources)?;
        let mut programs = BTreeMap::new();
        for (id, definition) in &manifest.programs {
            let mut source = String::new();
            for fragment in &definition.fragments {
                match fragment {
                    ProgramFragment::Source(fragment) => {
                        let path = manifest.fragments.get(fragment).ok_or_else(|| {
                            ShaderError::Manifest(format!(
                                "Program {id} uses unknown fragment {fragment}"
                            ))
                        })?;
                        let content = sources.get(path).ok_or_else(|| {
                            ShaderError::Manifest(format!(
                                "Fragment {fragment} is missing source {path}"
                            ))
                        })?;
                        source.push_str(content);
                    }
                    ProgramFragment::Constant { constant } => {
                        let value = manifest.constants.get(constant).ok_or_else(|| {
                            ShaderError::Manifest(format!(
                                "Program {id} uses unknown constant {constant}"
                            ))
                        })?;
                        source.push_str(&value.to_string());
                    }
                }
            }
            let program = ShaderProgram {
                definition: definition.clone(),
                source,
            };
            program.validate(id)?;
            programs.insert(id.clone(), program);
        }
        Ok(Self { programs })
    }

    pub fn program(&self, id: &str) -> Result<&ShaderProgram, ShaderError> {
        self.programs
            .get(id)
            .ok_or_else(|| ShaderError::UnknownProgram(id.to_owned()))
    }
}

impl ShaderProgram {
    /// Returns declared defaults plus validated caller overrides; no device dependency is required.
    pub fn pipeline_constants(
        &self,
        supplied: &BTreeMap<String, f64>,
    ) -> Result<BTreeMap<String, f64>, ShaderError> {
        let mut constants: BTreeMap<_, _> = self
            .definition
            .overrides
            .iter()
            .map(|(name, definition)| (name.clone(), definition.default))
            .collect();
        for (name, value) in supplied {
            let definition = self.definition.overrides.get(name).ok_or_else(|| {
                ShaderError::PipelineConstant {
                    name: name.clone(),
                    diagnostic: "the program does not declare this override".to_owned(),
                }
            })?;
            definition.validate_value(name, *value)?;
            constants.insert(name.clone(), *value);
        }
        Ok(constants)
    }
}

impl ShaderManifest {
    fn validate(&self, sources: &BTreeMap<String, String>) -> Result<(), ShaderError> {
        if self.schema_version != 1 || self.fragments.is_empty() || self.programs.is_empty() {
            return Err(ShaderError::Manifest(
                "schema_version must be 1 with nonempty fragments and programs".to_owned(),
            ));
        }
        for (id, path) in &self.fragments {
            if id.is_empty()
                || !path.ends_with(".wgsl")
                || path.contains(['\\', ':'])
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || !sources.contains_key(path)
            {
                return Err(ShaderError::Manifest(format!(
                    "Fragment {id} requires an embedded checkout-relative WGSL file: {path}"
                )));
            }
        }
        if let Some(path) = sources
            .keys()
            .find(|path| !self.fragments.values().any(|declared| declared == *path))
        {
            return Err(ShaderError::Manifest(format!(
                "Embedded shader file is not declared: {path}"
            )));
        }
        for (id, program) in &self.programs {
            if id.is_empty() || program.fragments.is_empty() {
                return Err(ShaderError::Manifest(format!(
                    "Program {id} requires a nonempty ID and fragments"
                )));
            }
        }
        if let Some(id) = self.fragments.keys().find(|id| {
            !self.programs.values().any(|program| {
                program.fragments.iter().any(
                    |fragment| matches!(fragment, ProgramFragment::Source(source) if source == *id),
                )
            })
        }) {
            return Err(ShaderError::Manifest(format!(
                "Declared fragment {id} is not used by any shader program"
            )));
        }
        for id in self.constants.keys() {
            if id.is_empty()
                || !self.programs.values().any(|program| {
                    program.fragments.iter().any(|fragment| {
                        matches!(fragment, ProgramFragment::Constant { constant } if constant == id)
                    })
                })
            {
                return Err(ShaderError::Manifest(format!(
                    "Constant {id} requires a nonempty ID used by a shader program"
                )));
            }
        }
        Ok(())
    }
}
