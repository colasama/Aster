use std::collections::BTreeMap;

use naga::{
    AddressSpace, ArraySize, Expression, Literal, ScalarKind, ShaderStage, StorageAccess,
    TypeInner, VectorSize,
};
use sha2::{Digest, Sha256};

use crate::{ShaderCatalog, ShaderError};

#[test]
fn post_process_preserves_complete_source_and_real_naga_resource_contract()
-> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    let program = catalog.program("post-process")?;
    assert_eq!(program.source.len(), 193083);
    assert_eq!(
        format!("{:x}", Sha256::digest(program.source.as_bytes())),
        "5323555f0dcad8d861f15dda7e04f31143888c0fc0a61fedd3f4cef8d4caac31"
    );
    assert_eq!(
        program.pipeline_constants(&BTreeMap::new())?,
        BTreeMap::from([("root_zero_operations".to_owned(), 0.0)])
    );
    let root_constants = BTreeMap::from([("root_zero_operations".to_owned(), 1.0)]);
    assert_eq!(program.pipeline_constants(&root_constants)?, root_constants);
    let module =
        naga::front::wgsl::parse_str(&program.source).map_err(|error| ShaderError::Parse {
            program: "post-process".to_owned(),
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
            ("fragment_main", ShaderStage::Fragment),
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
            ((0, 0), Some("hdr_scene")),
            ((0, 1), Some("linear_sampler")),
            ((0, 2), Some("settings")),
            ((0, 3), Some("effect_ops")),
            ((0, 4), Some("lut_texture")),
            ((0, 5), Some("lut_sampler")),
            ((0, 6), Some("blur_scene")),
            ((0, 7), Some("glow_scene")),
        ])
    );
    for (name, expected_span, expected_members) in [
        (
            "PostProcess",
            96,
            vec![
                (Some("resolution_time_exposure"), 0),
                (Some("color"), 16),
                (Some("optical"), 32),
                (Some("finish"), 48),
                (Some("program"), 64),
                (Some("grading"), 80),
            ],
        ),
        (
            "EffectOp",
            64,
            vec![
                (Some("header"), 0),
                (Some("p0"), 16),
                (Some("p1"), 32),
                (Some("p2"), 48),
            ],
        ),
    ] {
        let value = module
            .types
            .iter()
            .find_map(|(_, value)| (value.name.as_deref() == Some(name)).then_some(value))
            .ok_or_else(|| ShaderError::Manifest(format!("Post-process type {name} is absent")))?;
        let TypeInner::Struct { members, span } = &value.inner else {
            return Err(ShaderError::Manifest(format!(
                "Post-process type {name} is not a structure"
            )));
        };
        assert_eq!(*span, expected_span);
        assert_eq!(
            members
                .iter()
                .map(|member| (member.name.as_deref(), member.offset))
                .collect::<Vec<_>>(),
            expected_members
        );
        for member in members {
            assert!(matches!(
                module.types[member.ty].inner,
                TypeInner::Vector {
                    size: VectorSize::Quad,
                    scalar: naga::Scalar {
                        kind: ScalarKind::Float,
                        width: 4
                    },
                }
            ));
        }
    }
    for (_, variable) in module.global_variables.iter() {
        match variable.name.as_deref() {
            Some("settings") => {
                assert_eq!(variable.space, AddressSpace::Uniform);
                assert_eq!(
                    module.types[variable.ty].name.as_deref(),
                    Some("PostProcess")
                );
            }
            Some("effect_ops") => {
                assert_eq!(
                    variable.space,
                    AddressSpace::Storage {
                        access: StorageAccess::LOAD
                    }
                );
                let TypeInner::Array { base, size, stride } = module.types[variable.ty].inner
                else {
                    return Err(ShaderError::Manifest(
                        "Effect operations are not an array".to_owned(),
                    ));
                };
                assert_eq!(size, ArraySize::Dynamic);
                assert_eq!(stride, 64);
                assert_eq!(module.types[base].name.as_deref(), Some("EffectOp"));
            }
            _ => {}
        }
    }
    assert_eq!(module.overrides.len(), 1);
    for (_, value) in module.overrides.iter() {
        assert_eq!(value.name.as_deref(), Some("root_zero_operations"));
        assert_eq!(value.id, None);
        assert!(matches!(
            module.types[value.ty].inner,
            TypeInner::Scalar(naga::Scalar {
                kind: ScalarKind::Uint,
                width: 4,
            })
        ));
        let init = value.init.ok_or_else(|| {
            ShaderError::Manifest("Root post-process override has no default".to_owned())
        })?;
        assert!(matches!(
            module.global_expressions[init],
            Expression::Literal(Literal::U32(0))
        ));
    }
    Ok(())
}
