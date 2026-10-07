/// Native compilation keeps supplied generator positions invariant across arithmetic lowering.
pub struct GeneratorShader;

impl GeneratorShader {
    pub fn parse(source: &str) -> Result<naga::Module, String> {
        let mut module =
            naga::front::wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
        let mut replacements = Vec::new();
        for (handle, ty) in module.types.iter() {
            let mut ty = ty.clone();
            if let naga::TypeInner::Struct { members, .. } = &mut ty.inner {
                let mut changed = false;
                for member in members {
                    if let Some(naga::Binding::BuiltIn(naga::BuiltIn::Position { invariant })) =
                        &mut member.binding
                    {
                        changed |= !*invariant;
                        *invariant = true;
                    }
                }
                if changed {
                    replacements.push((handle, ty));
                }
            }
        }
        // WGSL structure names are unique and retained, so replacement preserves type identity.
        for (handle, ty) in replacements {
            module.types.replace(handle, ty);
        }
        for entry in &mut module.entry_points {
            if let Some(result) = &mut entry.function.result
                && let Some(naga::Binding::BuiltIn(naga::BuiltIn::Position { invariant })) =
                    &mut result.binding
            {
                *invariant = true;
            }
        }
        Ok(module)
    }
}

#[cfg(test)]
mod tests {
    use super::GeneratorShader;

    #[test]
    fn position_invariance_preserves_valid_supplied_wgsl() -> Result<(), String> {
        for source in [
            "@vertex fn main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }",
            "struct Out { @builtin(position) p: vec4f }; @vertex fn main() -> Out { return Out(vec4f(0, 0, 0, 1)); }",
            "struct Out { @invariant @builtin(position) p: vec4f }; @vertex fn main() -> Out { return Out(vec4f(0, 0, 0, 1)); }",
        ] {
            let module = GeneratorShader::parse(source)?;
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::empty(),
            )
            .validate(&module)
            .map_err(|error| error.to_string())?;
            let result = module.entry_points[0]
                .function
                .result
                .as_ref()
                .ok_or("result absent")?;
            let binding =
                if let naga::TypeInner::Struct { members, .. } = &module.types[result.ty].inner {
                    &members[0].binding
                } else {
                    &result.binding
                };
            assert!(matches!(
                binding,
                Some(naga::Binding::BuiltIn(naga::BuiltIn::Position {
                    invariant: true
                }))
            ));
        }
        assert!(GeneratorShader::parse("invalid shader").is_err());
        Ok(())
    }
}
