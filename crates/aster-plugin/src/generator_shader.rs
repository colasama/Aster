//! Naga-backed validation for the public scene-generator WGSL ABI.

use std::{collections::BTreeMap, path::PathBuf};

use crate::shader_types::ShaderTypes;
use crate::{PluginError, PluginKind, PluginManifest, generator};

#[derive(Clone, Copy)]
enum GeneratorFragmentOutput {
    Beauty,
    Auxiliary,
}

#[derive(Default)]
pub struct SceneGeneratorValidator {
    pub limits: crate::PluginLimits,
}

impl SceneGeneratorValidator {
    /// Validates an in-memory scene-generator package using the same manifest, quota, Naga, entry-point,
    /// and binding checks as an installed plugin. Bundled generators use this in conformance tests so
    /// their compiled-in WGSL cannot drift from the public ABI.
    pub fn validate(
        &self,
        manifest: &PluginManifest,
        sources: &BTreeMap<String, String>,
    ) -> Result<(), PluginError> {
        manifest.validate(&self.limits)?;
        if manifest.plugin.kind != PluginKind::SceneGenerator {
            return Err(PluginError::MissingSceneGenerator);
        }
        let graph = manifest
            .scene_generator
            .as_ref()
            .ok_or(PluginError::MissingSceneGenerator)?;
        let declared = graph.shader_paths();
        let mut total_bytes = 0_u64;
        for path in &declared {
            let source = sources
                .get(*path)
                .ok_or_else(|| PluginError::MissingShader(PathBuf::from(path)))?;
            if source.len() as u64 > self.limits.max_shader_bytes {
                return Err(PluginError::ShaderTooLarge(source.len() as u64));
            }
            total_bytes = total_bytes.saturating_add(source.len() as u64);
            if total_bytes > self.limits.max_plugin_shader_bytes {
                return Err(PluginError::ShaderPackageTooLarge(total_bytes));
            }
        }
        if let Some(path) = sources
            .keys()
            .find(|path| !declared.contains(path.as_str()))
        {
            return Err(PluginError::UndeclaredShaderSource(path.clone()));
        }
        Self::validate_scene_generator_shaders(graph, sources)
    }
    fn validate_scene_generator_shaders(
        graph: &generator::SceneGeneratorGraph,
        sources: &BTreeMap<String, String>,
    ) -> Result<(), PluginError> {
        use naga::{AddressSpace, ShaderStage, StorageAccess};

        let mut modules = BTreeMap::new();
        for (path, source) in sources {
            let module = naga::front::wgsl::parse_str(source)
                .map_err(|error| PluginError::ShaderParse(error.emit_to_string(source)))?;
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .map_err(|error| PluginError::ShaderValidation(error.to_string()))?;
            modules.insert(path.as_str(), module);
        }
        for pass in &graph.compute_passes {
            let module = modules
                .get(pass.shader.as_str())
                .ok_or_else(|| PluginError::MissingShader(PathBuf::from(&pass.shader)))?;
            let entry = module
                .entry_points
                .iter()
                .find(|entry| entry.name == pass.entry_point && entry.stage == ShaderStage::Compute)
                .ok_or_else(|| {
                    PluginError::GeneratorShaderAbi(format!(
                        "{} must expose @compute fn {}",
                        pass.shader, pass.entry_point
                    ))
                })?;
            if entry.workgroup_size != pass.workgroup_size {
                return Err(PluginError::GeneratorShaderAbi(format!(
                    "{} workgroup size does not match its manifest",
                    pass.entry_point
                )));
            }
            Self::validate_generator_bindings(
                module,
                graph.instance_stride,
                &[
                    (0, "aster_context", AddressSpace::Uniform),
                    (1, "aster_parameters", AddressSpace::Uniform),
                    (
                        2,
                        "aster_instances",
                        AddressSpace::Storage {
                            access: StorageAccess::LOAD | StorageAccess::STORE,
                        },
                    ),
                    (
                        3,
                        "aster_draw",
                        AddressSpace::Storage {
                            access: StorageAccess::LOAD | StorageAccess::STORE,
                        },
                    ),
                ],
            )?;
        }
        for variant in &graph.render_variants {
            Self::validate_generator_render_module(
                modules
                    .get(variant.shader.as_str())
                    .ok_or_else(|| PluginError::MissingShader(PathBuf::from(&variant.shader)))?,
                &variant.vertex_entry,
                &variant.fragment_entry,
                graph.instance_stride,
                GeneratorFragmentOutput::Beauty,
            )?;
            if let Some(auxiliary) = &variant.auxiliary {
                Self::validate_generator_render_module(
                    modules.get(auxiliary.shader.as_str()).ok_or_else(|| {
                        PluginError::MissingShader(PathBuf::from(&auxiliary.shader))
                    })?,
                    &auxiliary.vertex_entry,
                    &auxiliary.fragment_entry,
                    graph.instance_stride,
                    GeneratorFragmentOutput::Auxiliary,
                )?;
            }
        }
        Ok(())
    }
    fn validate_generator_render_module(
        module: &naga::Module,
        vertex_entry: &str,
        fragment_entry: &str,
        instance_stride: u32,
        output: GeneratorFragmentOutput,
    ) -> Result<(), PluginError> {
        use naga::{AddressSpace, ShaderStage, StorageAccess};

        let vertex = module
            .entry_points
            .iter()
            .find(|entry| entry.name == vertex_entry && entry.stage == ShaderStage::Vertex)
            .ok_or_else(|| {
                PluginError::GeneratorShaderAbi(format!(
                    "render shader must expose Vertex entry `{vertex_entry}`"
                ))
            })?;
        let fragment = module
            .entry_points
            .iter()
            .find(|entry| entry.name == fragment_entry && entry.stage == ShaderStage::Fragment)
            .ok_or_else(|| {
                PluginError::GeneratorShaderAbi(format!(
                    "render shader must expose Fragment entry `{fragment_entry}`"
                ))
            })?;
        Self::validate_generator_render_interface(module, vertex, fragment, output)?;
        Self::validate_generator_bindings(
            module,
            instance_stride,
            &[
                (0, "aster_context", AddressSpace::Uniform),
                (1, "aster_parameters", AddressSpace::Uniform),
                (
                    2,
                    "aster_instances",
                    AddressSpace::Storage {
                        access: StorageAccess::LOAD,
                    },
                ),
            ],
        )
    }
    fn validate_generator_render_interface(
        module: &naga::Module,
        vertex: &naga::EntryPoint,
        fragment: &naga::EntryPoint,
        output: GeneratorFragmentOutput,
    ) -> Result<(), PluginError> {
        use naga::{Binding, BuiltIn, ScalarKind, VectorSize};

        let vertex_inputs = Self::function_inputs(module, &vertex.function)?;
        if vertex_inputs.iter().any(|(binding, ty)| {
            !matches!(
                binding,
                Binding::BuiltIn(BuiltIn::VertexIndex | BuiltIn::InstanceIndex)
            ) || !module.is_scalar(*ty, ScalarKind::Uint)
        }) {
            return Err(PluginError::GeneratorShaderAbi("scene-generator vertex entries may read only u32 vertex_index and instance_index built-ins" .to_owned()));
        }

        let vertex_outputs = Self::function_output(module, &vertex.function)?;
        if !vertex_outputs.iter().any(|(binding, ty)| {
            matches!(binding, Binding::BuiltIn(BuiltIn::Position { .. }))
                && module.is_vector(*ty, VectorSize::Quad, naga::ScalarKind::Float)
        }) {
            return Err(PluginError::GeneratorShaderAbi(
                "scene-generator vertex entries must output @builtin(position) vec4f".to_owned(),
            ));
        }

        let fragment_inputs = Self::function_inputs(module, &fragment.function)?;
        for (binding, ty) in fragment_inputs {
            let Binding::Location { location, .. } = binding else {
                continue;
            };
            let Some((_, vertex_ty)) = vertex_outputs.iter().find(|(binding, _)| {
            matches!(binding, Binding::Location { location: found, .. } if *found == location)
        }) else {
            return Err(PluginError::GeneratorShaderAbi(format!(
                "fragment input @location({location}) is not written by its vertex entry"
            )));
        };
            if module.types[*vertex_ty].inner != module.types[ty].inner {
                return Err(PluginError::GeneratorShaderAbi(format!(
                    "render interface type at @location({location}) does not match between stages"
                )));
            }
        }

        let fragment_outputs = Self::function_output(module, &fragment.function)?;
        let valid = match output {
            GeneratorFragmentOutput::Beauty => {
                fragment_outputs.len() == 1
                    && matches!(
                        &fragment_outputs[0].0,
                        naga::Binding::Location { location: 0, .. }
                    )
                    && module.is_vector(
                        fragment_outputs[0].1,
                        VectorSize::Quad,
                        naga::ScalarKind::Float,
                    )
            }
            GeneratorFragmentOutput::Auxiliary => {
                fragment_outputs.len() == 5
                    && Self::output_at(&fragment_outputs, 0).is_some_and(|ty| {
                        module.is_vector(ty, VectorSize::Quad, naga::ScalarKind::Float)
                    })
                    && Self::output_at(&fragment_outputs, 1)
                        .is_some_and(|ty| module.is_scalar(ty, ScalarKind::Uint))
                    && Self::output_at(&fragment_outputs, 2)
                        .is_some_and(|ty| module.is_scalar(ty, ScalarKind::Uint))
                    && Self::output_at(&fragment_outputs, 3).is_some_and(|ty| {
                        module.is_vector(ty, VectorSize::Quad, naga::ScalarKind::Float)
                    })
                    && Self::output_at(&fragment_outputs, 4).is_some_and(|ty| {
                        module.is_vector(ty, VectorSize::Bi, naga::ScalarKind::Float)
                    })
            }
        };
        if !valid {
            let contract = match output {
                GeneratorFragmentOutput::Beauty => "@location(0) vec4f",
                GeneratorFragmentOutput::Auxiliary => {
                    "locations 0..4 as vec4f, u32, u32, vec4f, and vec2f"
                }
            };
            return Err(PluginError::GeneratorShaderAbi(format!(
                "scene-generator fragment entry must output {contract}"
            )));
        }
        Ok(())
    }
    fn function_inputs(
        module: &naga::Module,
        function: &naga::Function,
    ) -> Result<Vec<(naga::Binding, naga::Handle<naga::Type>)>, PluginError> {
        let mut result = Vec::new();
        for argument in &function.arguments {
            Self::flatten_interface(module, argument.ty, argument.binding.as_ref(), &mut result)?;
        }
        Ok(result)
    }
    fn function_output(
        module: &naga::Module,
        function: &naga::Function,
    ) -> Result<Vec<(naga::Binding, naga::Handle<naga::Type>)>, PluginError> {
        let Some(result) = &function.result else {
            return Err(PluginError::GeneratorShaderAbi(
                "render entry point must return a bound output".to_owned(),
            ));
        };
        let mut output = Vec::new();
        Self::flatten_interface(module, result.ty, result.binding.as_ref(), &mut output)?;
        Ok(output)
    }
    fn flatten_interface(
        module: &naga::Module,
        ty: naga::Handle<naga::Type>,
        binding: Option<&naga::Binding>,
        output: &mut Vec<(naga::Binding, naga::Handle<naga::Type>)>,
    ) -> Result<(), PluginError> {
        if let Some(binding) = binding {
            output.push((binding.clone(), ty));
            return Ok(());
        }
        let naga::TypeInner::Struct { members, .. } = &module.types[ty].inner else {
            return Err(PluginError::GeneratorShaderAbi(
                "entry-point interface value is missing an IO binding".to_owned(),
            ));
        };
        for member in members {
            Self::flatten_interface(module, member.ty, member.binding.as_ref(), output)?;
        }
        Ok(())
    }
    fn output_at(
        outputs: &[(naga::Binding, naga::Handle<naga::Type>)],
        expected: u32,
    ) -> Option<naga::Handle<naga::Type>> {
        outputs.iter().find_map(|(binding, ty)| {
            matches!(binding, naga::Binding::Location { location, .. } if *location == expected)
                .then_some(*ty)
        })
    }
    fn validate_generator_bindings(
        module: &naga::Module,
        instance_stride: u32,
        expected: &[(u32, &str, naga::AddressSpace)],
    ) -> Result<(), PluginError> {
        let bound = module
            .global_variables
            .iter()
            .filter_map(|(_, variable)| {
                variable.binding.as_ref().map(|binding| (binding, variable))
            })
            .collect::<Vec<_>>();
        if bound.len() != expected.len() {
            return Err(PluginError::GeneratorShaderAbi(format!(
                "shader must declare exactly {} standard group-0 bindings",
                expected.len()
            )));
        }
        for (binding, name, space) in expected {
            let variable = bound
                .iter()
                .find_map(|(resource, variable)| {
                    (resource.group == 0 && resource.binding == *binding).then_some(*variable)
                })
                .ok_or_else(|| {
                    PluginError::GeneratorShaderAbi(format!(
                        "missing @group(0) @binding({binding})"
                    ))
                })?;
            if variable.name.as_deref() != Some(*name) || variable.space != *space {
                return Err(PluginError::GeneratorShaderAbi(format!(
                    "binding {binding} must be `{name}` with the standard address space"
                )));
            }
            match binding {
                0 => Self::validate_generator_context(module, variable)?,
                1 => Self::validate_generator_parameters(module, variable)?,
                2 => Self::validate_generator_instances(module, variable, instance_stride)?,
                3 => Self::validate_generator_draw(module, variable)?,
                _ => {
                    return Err(PluginError::GeneratorShaderAbi(
                        "unsupported scene-generator binding".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }
    fn validate_generator_context(
        module: &naga::Module,
        variable: &naga::GlobalVariable,
    ) -> Result<(), PluginError> {
        use naga::{ScalarKind, TypeInner, VectorSize};

        let ty = &module.types[variable.ty];
        let TypeInner::Struct { members, span: 208 } = &ty.inner else {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterGeneratorContext must be a 208-byte struct".to_owned(),
            ));
        };
        let names = [
            "resolution",
            "composition_time",
            "local_time",
            "frame_duration",
            "reserved_time",
            "instance_count",
            "instance_seed",
            "layer_position_opacity",
            "layer_rotation",
            "layer_scale",
            "camera_position",
            "camera_rotation",
            "camera_projection",
            "composition",
            "ids",
            "camera_right",
            "camera_down",
            "camera_forward",
        ];
        let offsets = [
            0, 8, 12, 16, 20, 24, 28, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192,
        ];
        if ty.name.as_deref() != Some("AsterGeneratorContext")
            || members.len() != names.len()
            || members
                .iter()
                .zip(names.into_iter().zip(offsets))
                .any(|(member, (name, offset))| {
                    member.name.as_deref() != Some(name) || member.offset != offset
                })
        {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterGeneratorContext fields or offsets do not match ABI v1".to_owned(),
            ));
        }
        let valid = module.is_vector(members[0].ty, VectorSize::Bi, naga::ScalarKind::Float)
            && members[1..5]
                .iter()
                .all(|member| module.is_scalar(member.ty, ScalarKind::Float))
            && members[5..7]
                .iter()
                .all(|member| module.is_scalar(member.ty, ScalarKind::Uint))
            && members[7..14].iter().all(|member| {
                module.is_vector(member.ty, VectorSize::Quad, naga::ScalarKind::Float)
            })
            && module.is_vector(members[14].ty, VectorSize::Quad, naga::ScalarKind::Uint)
            && members[15..18].iter().all(|member| {
                module.is_vector(member.ty, VectorSize::Quad, naga::ScalarKind::Float)
            });
        if !valid {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterGeneratorContext field types do not match ABI v1".to_owned(),
            ));
        }
        Ok(())
    }
    fn validate_generator_parameters(
        module: &naga::Module,
        variable: &naga::GlobalVariable,
    ) -> Result<(), PluginError> {
        use naga::{ArraySize, TypeInner, VectorSize};

        let ty = &module.types[variable.ty];
        let TypeInner::Struct {
            members,
            span: 2_048,
        } = &ty.inner
        else {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterGeneratorParameters must be a 2048-byte struct".to_owned(),
            ));
        };
        if ty.name.as_deref() != Some("AsterGeneratorParameters")
            || members.len() != 1
            || members[0].name.as_deref() != Some("values")
            || members[0].offset != 0
        {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterGeneratorParameters fields or offsets do not match ABI v1".to_owned(),
            ));
        }
        match module.types[members[0].ty].inner {
            TypeInner::Array {
                base,
                size: ArraySize::Constant(size),
                stride: 16,
            } if size.get() == 128
                && module.is_vector(base, VectorSize::Quad, naga::ScalarKind::Float) =>
            {
                Ok(())
            }
            _ => Err(PluginError::GeneratorShaderAbi(
                "parameters.values must be `array<vec4f, 128>`".to_owned(),
            )),
        }
    }
    fn validate_generator_instances(
        module: &naga::Module,
        variable: &naga::GlobalVariable,
        expected_stride: u32,
    ) -> Result<(), PluginError> {
        use naga::{ArraySize, TypeInner};

        match module.types[variable.ty].inner {
            TypeInner::Array {
                size: ArraySize::Dynamic,
                stride,
                ..
            } if stride == expected_stride => Ok(()),
            TypeInner::Array {
                size: ArraySize::Dynamic,
                stride,
                ..
            } => Err(PluginError::GeneratorShaderAbi(format!(
                "aster_instances has stride {stride}; the manifest declares {expected_stride}"
            ))),
            _ => Err(PluginError::GeneratorShaderAbi(
                "aster_instances must be a runtime-sized array of fixed-stride records".to_owned(),
            )),
        }
    }
    fn validate_generator_draw(
        module: &naga::Module,
        variable: &naga::GlobalVariable,
    ) -> Result<(), PluginError> {
        use naga::{ScalarKind, TypeInner};

        let ty = &module.types[variable.ty];
        let TypeInner::Struct { members, span: 16 } = &ty.inner else {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterDrawIndirect must be a 16-byte struct".to_owned(),
            ));
        };
        let names = [
            "vertex_count",
            "instance_count",
            "first_vertex",
            "first_instance",
        ];
        let offsets = [0, 4, 8, 12];
        if ty.name.as_deref() != Some("AsterDrawIndirect")
            || members.len() != names.len()
            || members
                .iter()
                .zip(names.into_iter().zip(offsets))
                .any(|(member, (name, offset))| {
                    member.name.as_deref() != Some(name) || member.offset != offset
                })
            || !module.is_scalar(members[0].ty, ScalarKind::Uint)
            || !module.is_atomic_uint(members[1].ty)
            || !members[2..4]
                .iter()
                .all(|member| module.is_scalar(member.ty, ScalarKind::Uint))
        {
            return Err(PluginError::GeneratorShaderAbi(
                "AsterDrawIndirect does not match ABI v1".to_owned(),
            ));
        }
        Ok(())
    }
}
