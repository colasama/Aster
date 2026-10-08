/// Preserve post-fragment multiplication boundaries before color quantization and FXAA.
pub struct PostShader;

impl PostShader {
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
