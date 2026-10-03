use std::collections::BTreeMap;

use naga::{Expression, Literal, ScalarKind, ShaderStage, TypeInner};

use crate::{ShaderCatalog, ShaderError, ShaderManifest};

#[test]
fn motion_override_preserves_real_naga_entry_points_bindings_and_uniform_layout()
-> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    let program = catalog.program("motion-blur")?;
    let module =
        naga::front::wgsl::parse_str(&program.source).map_err(|error| ShaderError::Parse {
            program: "motion-blur".to_owned(),
            diagnostic: error.emit_to_string(&program.source),
        })?;
    assert_eq!(
        module
            .entry_points
            .iter()
            .map(|entry| (entry.name.as_str(), entry.stage))
            .collect::<BTreeMap<_, _>>(),
        BTreeMap::from([
            ("vertex_main", ShaderStage::Vertex),
            ("tile_max_fragment", ShaderStage::Fragment),
            ("neighbor_max_fragment", ShaderStage::Fragment),
            ("reconstruct_fragment", ShaderStage::Fragment),
        ])
    );
    assert_eq!(
        module
            .global_variables
            .iter()
            .filter_map(|(_, variable)| variable
                .binding
                .as_ref()
                .map(|binding| { ((binding.group, binding.binding), variable.name.as_deref()) }))
            .collect::<BTreeMap<_, _>>(),
        BTreeMap::from([
            ((0, 0), Some("tile_motion_vectors")),
            ((0, 1), Some("tile_settings")),
            ((0, 2), Some("tile_maximum")),
            ((0, 3), Some("hdr_scene")),
            ((0, 4), Some("motion_vectors")),
            ((0, 5), Some("object_ids")),
            ((0, 6), Some("neighbor_maximum")),
            ((0, 7), Some("linear_sampler")),
            ((0, 8), Some("settings")),
        ])
    );
    for (_, variable) in module.global_variables.iter() {
        if matches!(variable.name.as_deref(), Some("tile_settings" | "settings")) {
            assert!(matches!(
                module.types[variable.ty].inner,
                TypeInner::Struct { span: 32, .. }
            ));
        }
    }
    assert_eq!(module.overrides.len(), 1);
    for (_, value) in module.overrides.iter() {
        assert_eq!(value.name.as_deref(), Some("tile_extent"));
        assert!(matches!(
            module.types[value.ty].inner,
            TypeInner::Scalar(naga::Scalar {
                kind: ScalarKind::Uint,
                width: 4
            })
        ));
        let init = value.init.ok_or_else(|| {
            ShaderError::Manifest("Motion tile override must preserve its default".to_owned())
        })?;
        assert!(matches!(
            module.global_expressions[init],
            Expression::Literal(Literal::U32(16))
        ));
    }
    assert_eq!(
        program.pipeline_constants(&BTreeMap::new())?,
        BTreeMap::from([("tile_extent".to_owned(), 16.0)])
    );
    for tile_extent in [8.0, 16.0, 32.0] {
        let constants = BTreeMap::from([("tile_extent".to_owned(), tile_extent)]);
        assert_eq!(program.pipeline_constants(&constants)?, constants);
    }
    assert_eq!(
        catalog
            .program("layer-composite")?
            .pipeline_constants(&BTreeMap::new())?,
        BTreeMap::from([("blend_mode".to_owned(), 0.0)])
    );
    Ok(())
}

#[test]
fn motion_manifest_cannot_relabel_the_wgsl_override_default() -> Result<(), ShaderError> {
    let mut manifest: ShaderManifest =
        serde_json::from_str(include_str!("../../../shaders/manifest.json"))?;
    let definition = manifest
        .programs
        .get_mut("motion-blur")
        .and_then(|program| program.overrides.get_mut("tile_extent"))
        .ok_or_else(|| ShaderError::Manifest("Motion override is absent".to_owned()))?;
    definition.default = 32.0;
    let result = ShaderCatalog::from_json(
        &serde_json::to_string(&manifest)?,
        ShaderCatalog::embedded_sources(),
    );
    assert!(matches!(
        result,
        Err(ShaderError::Manifest(message))
            if message.contains("motion-blur override tile_extent type or default")
    ));
    Ok(())
}
