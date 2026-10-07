/// Native lowering preserves generator positions and finite arithmetic across GPU compilers.
pub struct GeneratorShader;

impl GeneratorShader {
    pub fn parse(source: &str) -> Result<naga::Module, String> {
        let module =
            naga::front::wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
        let normalized = Self::ordered_normalization(source, &module)?;
        let module = naga::front::wgsl::parse_str(&normalized)
            .map_err(|error| error.emit_to_string(&normalized))?;
        let bounded = Self::bounded_products(&normalized, &module)?;
        let mut module = naga::front::wgsl::parse_str(&bounded)
            .map_err(|error| error.emit_to_string(&bounded))?;
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
    fn finite_arithmetic_preserves_nested_types_and_single_evaluation() -> Result<(), String> {
        let source = r#"
fn aster_native_normalize_vec3f(value: vec3f) -> vec3f { return value; }
fn nested(a: f32, b: vec3f, i: u32) -> vec3f {
    var value = b;
    value *= a;
    let integral = i * 2u;
    return normalize((a * a) * value + vec3f(f32(integral))) + normalize(b);
}
@vertex fn main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let uv = normalize(vec2f(f32(index), 2.0));
    return normalize(vec4f(nested(0.5, vec3f(1.0), 2u), uv.x));
}
"#;
        let module = GeneratorShader::parse(source)?;
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .map_err(|e| e.to_string())?;
        let functions = module
            .functions
            .iter()
            .map(|(_, f)| f)
            .chain(module.entry_points.iter().map(|e| &e.function));
        let mut clamps = 0;
        let mut lengths = 0;
        let mut integer_products = 0;
        for function in functions {
            for (_, expression) in function.expressions.iter() {
                match expression {
                    naga::Expression::Math {
                        fun: naga::MathFunction::Normalize,
                        ..
                    } => return Err("normalization intrinsic remained".into()),
                    naga::Expression::Math {
                        fun: naga::MathFunction::Clamp,
                        ..
                    } => clamps += 1,
                    naga::Expression::Math {
                        fun: naga::MathFunction::Length,
                        ..
                    } => lengths += 1,
                    naga::Expression::Binary {
                        op: naga::BinaryOperator::Multiply,
                        right,
                        ..
                    } if matches!(
                        function.expressions[*right],
                        naga::Expression::Literal(naga::Literal::U32(2))
                    ) =>
                    {
                        integer_products += 1
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(lengths, 3);
        assert_eq!(integer_products, 1);
        assert_eq!(clamps, 2);
        assert!(
            module
                .functions
                .iter()
                .any(|(_, f)| f.name.as_deref() == Some("aster_native_normalize_vec3f_"))
        );
        Ok(())
    }

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
