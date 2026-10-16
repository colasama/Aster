/// Preserve post-fragment multiplication boundaries before color quantization and FXAA.
pub struct PostShader;

impl PostShader {
    /// Reuse two recent blur lookups within one fragment invocation. The original shared
    /// sampler still performs every miss, preserving its tap order and LOD arithmetic.
    pub fn specialized_blur_cache(source: &str, codes: &[u32]) -> Result<naga::Module, String> {
        let declaration = "fn sample_blur(";
        if source.matches(declaration).count() != 1 {
            return Err("shared blur sampler declaration changed".into());
        }
        let mut source = source.replacen(declaration, "fn aster_native_blur_sample(", 1);
        source.push_str(r#"
struct AsterNativeBlurSample {
  uv: vec2f,
  radius: f32,
  valid: bool,
  color: vec3f,
}
var<private> aster_native_blur_0: AsterNativeBlurSample;
var<private> aster_native_blur_1: AsterNativeBlurSample;
fn sample_blur(uv: vec2f, radius: f32) -> vec3f {
  if aster_native_blur_0.valid && all(uv == aster_native_blur_0.uv) && radius == aster_native_blur_0.radius {
    return aster_native_blur_0.color;
  }
  if aster_native_blur_1.valid && all(uv == aster_native_blur_1.uv) && radius == aster_native_blur_1.radius {
    let hit = aster_native_blur_1;
    aster_native_blur_1 = aster_native_blur_0;
    aster_native_blur_0 = hit;
    return hit.color;
  }
  let color = aster_native_blur_sample(uv, radius);
  aster_native_blur_1 = aster_native_blur_0;
  aster_native_blur_0 = AsterNativeBlurSample(uv, radius, true, color);
  return color;
}
"#);
        Self::specialized(&source, codes)
    }

    /// Remove unreachable opcode cases without changing the shared shader's arithmetic or order.
    /// The caller must select this module only for programs whose opcodes are in `codes`.
    pub fn specialized(source: &str, codes: &[u32]) -> Result<naga::Module, String> {
        let mut module = Self::parse(source)?;
        let fragment = module
            .entry_points
            .iter_mut()
            .find(|entry| entry.name == "fragment_main")
            .ok_or("post fragment absent")?;
        let selectors = fragment
            .function
            .named_expressions
            .iter()
            .filter(|(_, name)| name.as_str() == "code")
            .map(|(handle, _)| *handle)
            .collect::<Vec<_>>();
        let count = Self::prune(&mut fragment.function.body, &selectors, codes);
        if count != 2 {
            return Err(format!("expected two post opcode switches, found {count}"));
        }
        // Removed branches leave named temporaries in the arena. Drop debug names so
        // compaction can retire those expressions before normal shader validation.
        fragment.function.named_expressions.clear();
        naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
        Ok(module)
    }

    fn prune(
        block: &mut naga::Block,
        selectors: &[naga::Handle<naga::Expression>],
        codes: &[u32],
    ) -> usize {
        let mut count = 0;
        for statement in block.iter_mut() {
            match statement {
                naga::Statement::Switch { selector, cases } => {
                    if selectors.contains(selector) {
                        cases.retain(|case| match case.value {
                            naga::SwitchValue::U32(code) => codes.contains(&code),
                            _ => true,
                        });
                        count += 1;
                    }
                    for case in cases {
                        count += Self::prune(&mut case.body, selectors, codes);
                    }
                }
                naga::Statement::Block(body) => count += Self::prune(body, selectors, codes),
                naga::Statement::If { accept, reject, .. } => {
                    count += Self::prune(accept, selectors, codes);
                    count += Self::prune(reject, selectors, codes);
                }
                naga::Statement::Loop {
                    body, continuing, ..
                } => {
                    count += Self::prune(body, selectors, codes);
                    count += Self::prune(continuing, selectors, codes);
                }
                _ => {}
            }
        }
        count
    }

    pub fn parse(source: &str) -> Result<naga::Module, String> {
        let module =
            naga::front::wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
        let source =
            crate::GeneratorShader::bounded_products(source, &module, Some(&["fragment_main"]))?;
        naga::front::wgsl::parse_str(&source).map_err(|error| error.emit_to_string(&source))
    }
}

#[cfg(test)]
mod tests {
    use super::PostShader;

    #[test]
    fn reachable_post_programs_validate_and_preserve_complete_program()
    -> Result<(), Box<dyn std::error::Error>> {
        let catalog = crate::ShaderCatalog::embedded()?;
        let source = &catalog.program("post-process")?.source;
        let original = PostShader::parse(source)?;
        for codes in [
            vec![50],
            vec![12, 17, 27, 102, 104, 105],
            vec![106, 107, 183],
            (0..=268).collect(),
        ] {
            let specialized = PostShader::specialized(source, &codes)?;
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&specialized)?;
            let old = original
                .entry_points
                .iter()
                .find(|entry| entry.name == "fragment_main")
                .ok_or("fragment")?;
            let new = specialized
                .entry_points
                .iter()
                .find(|entry| entry.name == "fragment_main")
                .ok_or("fragment")?;
            if codes.len() < 269 {
                assert!(new.function.expressions.len() < old.function.expressions.len());
            }
            let mut expected = original.clone();
            expected
                .entry_points
                .iter_mut()
                .find(|entry| entry.name == "fragment_main")
                .ok_or("fragment")?
                .function
                .named_expressions
                .clear();
            naga::compact::compact(&mut expected, naga::compact::KeepUnused::No);
            if codes.len() == 269 {
                assert_eq!(format!("{expected:?}"), format!("{specialized:?}"));
            }
        }
        Ok(())
    }

    #[test]
    fn post_lowering_only_bounds_fragment_products() -> Result<(), Box<dyn std::error::Error>> {
        let source = crate::ShaderCatalog::embedded()?
            .program("post-process")?
            .source
            .clone();
        let original = naga::front::wgsl::parse_str(&source)?;
        let lowered = PostShader::parse(&source)?;
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&lowered)?;
        for ((_, old), (_, new)) in original.functions.iter().zip(lowered.functions.iter()) {
            assert_eq!(old.name, new.name);
            assert_eq!(old.expressions.len(), new.expressions.len());
        }
        assert_eq!(original.functions.len(), lowered.functions.len());
        for (old, new) in original.entry_points.iter().zip(&lowered.entry_points) {
            assert_eq!(old.name, new.name);
            if old.name == "fragment_main" {
                assert!(new.function.expressions.len() > old.function.expressions.len());
            } else {
                assert_eq!(
                    old.function.expressions.len(),
                    new.function.expressions.len()
                );
            }
        }
        Ok(())
    }
}
