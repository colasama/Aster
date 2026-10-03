use naga::{AddressSpace, ArraySize, ScalarKind, StorageAccess, TypeInner, VectorSize};

use crate::{ShaderCatalog, ShaderError};

struct GeneratorModule {
    module: naga::Module,
}

impl GeneratorModule {
    fn load(catalog: &ShaderCatalog, id: &str) -> Result<Self, ShaderError> {
        let source = &catalog.program(id)?.source;
        let module = naga::front::wgsl::parse_str(source).map_err(|error| ShaderError::Parse {
            program: id.to_owned(),
            diagnostic: error.emit_to_string(source),
        })?;
        Ok(Self { module })
    }

    fn structure(&self, name: &str, bytes: u32) -> Result<&[naga::StructMember], ShaderError> {
        let value = self
            .module
            .types
            .iter()
            .find_map(|(_, value)| (value.name.as_deref() == Some(name)).then_some(value))
            .ok_or_else(|| ShaderError::Manifest(format!("ABI structure {name} is absent")))?;
        let TypeInner::Struct { members, span } = &value.inner else {
            return Err(ShaderError::Manifest(format!(
                "ABI type {name} is not a structure"
            )));
        };
        assert_eq!(*span, bytes, "{name}");
        Ok(members)
    }

    fn resource(
        &self,
        name: &str,
        binding: u32,
        space: AddressSpace,
    ) -> Result<&naga::GlobalVariable, ShaderError> {
        let variable = self
            .module
            .global_variables
            .iter()
            .find_map(|(_, variable)| (variable.name.as_deref() == Some(name)).then_some(variable))
            .ok_or_else(|| ShaderError::Manifest(format!("ABI resource {name} is absent")))?;
        assert_eq!(
            variable.binding,
            Some(naga::ResourceBinding { group: 0, binding })
        );
        assert_eq!(variable.space, space, "{name}");
        Ok(variable)
    }
}

#[test]
fn audio_analysis_keeps_fixed_history_and_waveform_layout() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    let shader = GeneratorModule::load(&catalog, "audio-analysis-abi")?;
    let members = shader.structure("AsterAudioAnalysis", 9280)?;
    assert_eq!(
        members
            .iter()
            .map(|member| (member.name.as_deref(), member.offset))
            .collect::<Vec<_>>(),
        [
            (Some("info"), 0),
            (Some("timing"), 16),
            (Some("levels"), 32),
            (Some("energy"), 48),
            (Some("spectrum"), 64),
            (Some("waveform"), 8256),
        ]
    );
    for (index, member) in members.iter().enumerate() {
        let value = &shader.module.types[member.ty].inner;
        if index < 4 {
            assert!(
                matches!(value, TypeInner::Vector { size: VectorSize::Quad, scalar }
                if scalar.width == 4 && scalar.kind == if index == 0 { ScalarKind::Uint } else { ScalarKind::Float })
            );
        } else {
            let TypeInner::Array { base, size, stride } = value else {
                return Err(ShaderError::Manifest(
                    "Audio samples are not an array".to_owned(),
                ));
            };
            let expected_count = if index == 4 { 2048 } else { 256 };
            assert!(matches!(size, ArraySize::Constant(count) if count.get() == expected_count));
            assert_eq!(*stride, 4);
            assert!(matches!(
                shader.module.types[*base].inner,
                TypeInner::Scalar(naga::Scalar {
                    kind: ScalarKind::Float,
                    width: 4
                })
            ));
        }
    }
    assert!(shader.module.entry_points.is_empty());
    assert!(shader.module.global_variables.is_empty());
    Ok(())
}

#[test]
fn generator_abi_preserves_cpu_packing_and_particle_storage_access() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    for id in ["scene-generator-abi", "particle-compute", "particle-render"] {
        let shader = GeneratorModule::load(&catalog, id)?;
        let context = shader.structure("AsterGeneratorContext", 208)?;
        assert_eq!(
            context
                .iter()
                .map(|member| (member.name.as_deref(), member.offset))
                .collect::<Vec<_>>(),
            [
                (Some("resolution"), 0),
                (Some("composition_time"), 8),
                (Some("local_time"), 12),
                (Some("frame_duration"), 16),
                (Some("reserved_time"), 20),
                (Some("instance_count"), 24),
                (Some("instance_seed"), 28),
                (Some("layer_position_opacity"), 32),
                (Some("layer_rotation"), 48),
                (Some("layer_scale"), 64),
                (Some("camera_position"), 80),
                (Some("camera_rotation"), 96),
                (Some("camera_projection"), 112),
                (Some("composition"), 128),
                (Some("ids"), 144),
                (Some("camera_right"), 160),
                (Some("camera_down"), 176),
                (Some("camera_forward"), 192),
            ]
        );
        let parameters = shader.structure("AsterGeneratorParameters", 2048)?;
        assert_eq!(parameters.len(), 1);
        assert_eq!(parameters[0].name.as_deref(), Some("values"));
        assert_eq!(parameters[0].offset, 0);
        let TypeInner::Array { base, size, stride } = shader.module.types[parameters[0].ty].inner
        else {
            return Err(ShaderError::Manifest(
                "Generator parameters are not an array".to_owned(),
            ));
        };
        assert!(matches!(size, ArraySize::Constant(count) if count.get() == 128));
        assert_eq!(stride, 16);
        assert!(matches!(
            shader.module.types[base].inner,
            TypeInner::Vector {
                size: VectorSize::Quad,
                scalar: naga::Scalar {
                    kind: ScalarKind::Float,
                    width: 4
                }
            }
        ));
        let indirect = shader.structure("AsterDrawIndirect", 16)?;
        assert_eq!(
            indirect
                .iter()
                .map(|member| (member.name.as_deref(), member.offset))
                .collect::<Vec<_>>(),
            [
                (Some("vertex_count"), 0),
                (Some("instance_count"), 4),
                (Some("first_vertex"), 8),
                (Some("first_instance"), 12)
            ]
        );
        for (index, member) in indirect.iter().enumerate() {
            match shader.module.types[member.ty].inner {
                TypeInner::Atomic(scalar) if index == 1 => {
                    assert_eq!(scalar.kind, ScalarKind::Uint);
                    assert_eq!(scalar.width, 4);
                }
                TypeInner::Scalar(scalar) if index != 1 => {
                    assert_eq!(scalar.kind, ScalarKind::Uint);
                    assert_eq!(scalar.width, 4);
                }
                _ => {
                    return Err(ShaderError::Manifest(
                        "Indirect draw fields changed".to_owned(),
                    ));
                }
            }
        }
        if id == "scene-generator-abi" {
            assert!(shader.module.entry_points.is_empty());
            assert!(shader.module.global_variables.is_empty());
            continue;
        }
        for (name, binding, ty) in [
            ("aster_context", 0, "AsterGeneratorContext"),
            ("aster_parameters", 1, "AsterGeneratorParameters"),
        ] {
            let resource = shader.resource(name, binding, AddressSpace::Uniform)?;
            assert_eq!(shader.module.types[resource.ty].name.as_deref(), Some(ty));
        }
        let access = if id == "particle-compute" {
            StorageAccess::LOAD | StorageAccess::STORE
        } else {
            StorageAccess::LOAD
        };
        let instances = shader.resource("aster_instances", 2, AddressSpace::Storage { access })?;
        let TypeInner::Array { base, size, stride } = shader.module.types[instances.ty].inner
        else {
            return Err(ShaderError::Manifest(
                "Particle storage is not an array".to_owned(),
            ));
        };
        assert_eq!(size, ArraySize::Dynamic);
        assert_eq!(stride, 48);
        assert_eq!(shader.module.types[base].name.as_deref(), Some("Particle"));
        let particle = shader.structure("Particle", 48)?;
        assert_eq!(
            particle
                .iter()
                .map(|member| (member.name.as_deref(), member.offset))
                .collect::<Vec<_>>(),
            [
                (Some("current"), 0),
                (Some("previous"), 16),
                (Some("appearance"), 32)
            ]
        );
        for member in particle {
            assert!(matches!(
                shader.module.types[member.ty].inner,
                TypeInner::Vector {
                    size: VectorSize::Quad,
                    scalar: naga::Scalar {
                        kind: ScalarKind::Float,
                        width: 4
                    }
                }
            ));
        }
        if id == "particle-compute" {
            let draw = shader.resource("aster_draw", 3, AddressSpace::Storage { access })?;
            assert_eq!(
                shader.module.types[draw.ty].name.as_deref(),
                Some("AsterDrawIndirect")
            );
            assert_eq!(shader.module.entry_points.len(), 1);
            assert_eq!(shader.module.entry_points[0].name, "compute_main");
            assert_eq!(
                shader.module.entry_points[0].stage,
                naga::ShaderStage::Compute
            );
            assert_eq!(shader.module.entry_points[0].workgroup_size, [256, 1, 1]);
        }
        assert_eq!(
            shader.module.global_variables.len(),
            if id == "particle-compute" { 4 } else { 3 }
        );
    }
    Ok(())
}
