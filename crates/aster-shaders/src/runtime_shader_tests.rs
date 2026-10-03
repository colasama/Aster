use std::collections::BTreeMap;

use naga::{AddressSpace, ImageClass, ImageDimension, ScalarKind, TypeInner};
use sha2::{Digest, Sha256};

use crate::{ShaderCatalog, ShaderError};

#[test]
fn runtime_programs_preserve_original_expanded_bytes() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    for (id, bytes, sha256) in [
        (
            "scene-generator-abi",
            647,
            "d473e7dc4529727fc20f6d4736ac0faa75023f7b3261aa0f5653a6c04cae76a7",
        ),
        (
            "audio-analysis-abi",
            156,
            "62f62065792d3d2e37db6abd3ba68350ed21007c35f0b978c7aefdcc529a66b9",
        ),
        (
            "particle-compute",
            8459,
            "8e9b65c7e2fbab32928cfe9028693c81b6b3aa562e3d446992533a26d2433e8b",
        ),
        (
            "particle-render",
            10062,
            "2ad720ba4ee2d2b08517d9ff955d973a0ca360438062b19716ab14c44240cf77",
        ),
        (
            "text-motion-blur-raster",
            1327,
            "8091f9803a1dcf9ab56af3a563510b04c66aef859c2c13d03f1e4e0304424a58",
        ),
        (
            "diagnostic-scene",
            1068,
            "96aad590904c84da9adbc90158e37921d3465c1771ef0264544790264727d8d9",
        ),
        (
            "diagnostic-float",
            1283,
            "47d66552a67133c2fe2e40fa887c7cc79a71322648d3c45cfac9711c88f46aec",
        ),
        (
            "diagnostic-uint",
            1133,
            "ee9105a349526211870ec6e3752fa685d8831bf3800dfbafadc8870c20e61454",
        ),
    ] {
        let program = catalog.program(id)?;
        assert_eq!(program.source.len(), bytes, "{id}");
        assert_eq!(
            format!("{:x}", Sha256::digest(program.source.as_bytes())),
            sha256,
            "{id}"
        );
        assert!(program.pipeline_constants(&BTreeMap::new())?.is_empty());
    }
    Ok(())
}

#[test]
fn text_and_diagnostics_preserve_texture_and_uniform_contracts() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    for id in [
        "text-motion-blur-raster",
        "diagnostic-scene",
        "diagnostic-float",
        "diagnostic-uint",
    ] {
        let program = catalog.program(id)?;
        let module =
            naga::front::wgsl::parse_str(&program.source).map_err(|error| ShaderError::Parse {
                program: id.to_owned(),
                diagnostic: error.emit_to_string(&program.source),
            })?;
        let text = id == "text-motion-blur-raster";
        let variables = module
            .global_variables
            .iter()
            .map(|(_, variable)| {
                let binding = variable.binding.as_ref().ok_or_else(|| {
                    ShaderError::Manifest(format!("{id} has an unbound resource"))
                })?;
                assert_eq!(binding.group, 0);
                Ok((binding.binding, variable))
            })
            .collect::<Result<BTreeMap<_, _>, ShaderError>>()?;
        assert_eq!(variables.len(), if text { 3 } else { 2 });
        let source = variables
            .get(&0)
            .ok_or_else(|| ShaderError::Manifest(format!("{id} texture is absent")))?;
        assert_eq!(source.space, AddressSpace::Handle);
        let expected_kind = if id == "diagnostic-uint" {
            ScalarKind::Uint
        } else {
            ScalarKind::Float
        };
        assert!(matches!(module.types[source.ty].inner, TypeInner::Image {
            dim: ImageDimension::D2, arrayed: false, class: ImageClass::Sampled { kind, multi: false }
        } if kind == expected_kind));
        let uniform = variables
            .get(&if text { 2 } else { 1 })
            .ok_or_else(|| ShaderError::Manifest(format!("{id} uniform is absent")))?;
        assert_eq!(uniform.space, AddressSpace::Uniform);
        assert!(matches!(
            module.types[uniform.ty].inner,
            TypeInner::Struct { span: 16, .. }
        ));
        if text {
            let sampler = variables
                .get(&1)
                .ok_or_else(|| ShaderError::Manifest("Text sampler is absent".to_owned()))?;
            assert_eq!(sampler.space, AddressSpace::Handle);
            assert!(matches!(
                module.types[sampler.ty].inner,
                TypeInner::Sampler { comparison: false }
            ));
        }
    }
    Ok(())
}
