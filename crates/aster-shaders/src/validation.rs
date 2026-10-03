use std::collections::BTreeMap;

use naga::{Expression, Literal, ScalarKind, TypeInner};

use crate::{EntryPoint, OverrideType, ShaderError, ShaderProgram, ShaderStage};

impl ShaderProgram {
    pub(crate) fn validate(&self, id: &str) -> Result<(), ShaderError> {
        let module =
            naga::front::wgsl::parse_str(&self.source).map_err(|error| ShaderError::Parse {
                program: id.to_owned(),
                diagnostic: error.emit_to_string(&self.source),
            })?;
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .map_err(|error| ShaderError::Validation {
            program: id.to_owned(),
            diagnostic: error.to_string(),
        })?;
        let mut actual_entries = Vec::new();
        for entry in &module.entry_points {
            let stage = match entry.stage {
                naga::ShaderStage::Vertex => ShaderStage::Vertex,
                naga::ShaderStage::Fragment => ShaderStage::Fragment,
                naga::ShaderStage::Compute => ShaderStage::Compute,
                _ => {
                    return Err(ShaderError::Manifest(format!(
                        "Program {id} uses an unsupported entry point stage"
                    )));
                }
            };
            actual_entries.push(EntryPoint {
                name: entry.name.clone(),
                stage,
            });
        }
        actual_entries.sort();
        let mut declared_entries = self.definition.entry_points.clone();
        declared_entries.sort();
        if actual_entries != declared_entries {
            return Err(ShaderError::Manifest(format!(
                "Program {id} entry points differ from its WGSL module"
            )));
        }
        self.validate_overrides(id, &module)
    }

    fn validate_overrides(&self, id: &str, module: &naga::Module) -> Result<(), ShaderError> {
        let mut actual = BTreeMap::new();
        for (_, value) in module.overrides.iter() {
            let name = value.name.as_ref().ok_or_else(|| {
                ShaderError::Manifest(format!("Program {id} contains an unnamed override"))
            })?;
            if value.id.is_some() {
                return Err(ShaderError::Manifest(format!(
                    "Program {id} override {name} uses an undeclared numeric pipeline ID"
                )));
            }
            actual.insert(name, value);
        }
        if actual.len() != self.definition.overrides.len() {
            return Err(ShaderError::Manifest(format!(
                "Program {id} override count differs from its WGSL module"
            )));
        }
        for (name, definition) in &self.definition.overrides {
            definition.validate_value(name, definition.default)?;
            let value = actual.get(name).ok_or_else(|| {
                ShaderError::Manifest(format!("Program {id} does not declare override {name}"))
            })?;
            let type_matches = matches!(
                (definition.value_type, &module.types[value.ty].inner),
                (
                    OverrideType::U32,
                    TypeInner::Scalar(naga::Scalar {
                        kind: ScalarKind::Uint,
                        width: 4
                    })
                )
            );
            let default_matches = value.init.is_some_and(|init| {
                matches!(
                    &module.global_expressions[init],
                    Expression::Literal(Literal::U32(default))
                        if f64::from(*default) == definition.default
                )
            });
            if !type_matches || !default_matches {
                return Err(ShaderError::Manifest(format!(
                    "Program {id} override {name} type or default differs from its WGSL module"
                )));
            }
        }
        Ok(())
    }
}
