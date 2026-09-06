use naga::{
    AddressSpace, ArraySize, Binding, ImageClass, ImageDimension, Module, ScalarKind, ShaderStage,
    TypeInner, VectorSize,
};

use crate::shader_types::ShaderTypes;
pub struct EffectAbi {
    module: Module,
}

impl EffectAbi {
    pub const ENTRY_POINT: &str = "aster_effect";
    pub const PARAMETER_VECTORS: u32 = 16;
    pub const UNIFORM_SIZE: u32 = 272;

    pub fn validate_source(source: &str) -> Result<(), crate::PluginError> {
        let module = naga::front::wgsl::parse_str(source)
            .map_err(|error| crate::PluginError::ShaderParse(error.emit_to_string(source)))?;
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .map_err(|error| crate::PluginError::ShaderValidation(error.to_string()))?;
        Self { module }
            .validate()
            .map_err(crate::PluginError::ShaderAbi)
    }
    fn validate(&self) -> Result<(), String> {
        let module = &self.module;
        if module.entry_points.len() != 1 {
            return Err("v1 effects must expose exactly one shader entry point".into());
        }
        let entry = &module.entry_points[0];
        if entry.name != Self::ENTRY_POINT || entry.stage != ShaderStage::Fragment {
            return Err(format!(
                "v1 effects require @fragment fn {}",
                Self::ENTRY_POINT
            ));
        }
        if entry.function.arguments.len() != 1
            || !matches!(
                &entry.function.arguments[0].binding,
                Some(Binding::Location { location: 0, .. })
            )
            || !module.is_vector(
                entry.function.arguments[0].ty,
                VectorSize::Bi,
                ScalarKind::Float,
            )
        {
            return Err("aster_effect must accept @location(0) uv: vec2f".into());
        }
        let Some(result) = &entry.function.result else {
            return Err("aster_effect must return @location(0) vec4f".into());
        };
        if !matches!(&result.binding, Some(Binding::Location { location: 0, .. }))
            || !module.is_vector(result.ty, VectorSize::Quad, ScalarKind::Float)
        {
            return Err("aster_effect must return @location(0) vec4f".into());
        }

        let bound = module
            .global_variables
            .iter()
            .filter(|(_, variable)| variable.binding.is_some())
            .collect::<Vec<_>>();
        if bound.len() != 3 {
            return Err("v1 effects may declare only bindings @group(0) @binding(0..2)".into());
        }
        let source = self.bound_variable(0)?;
        if source.name.as_deref() != Some("aster_source")
            || source.space != AddressSpace::Handle
            || !matches!(
                module.types[source.ty].inner,
                TypeInner::Image {
                    dim: ImageDimension::D2,
                    arrayed: false,
                    class: ImageClass::Sampled {
                        kind: ScalarKind::Float,
                        multi: false
                    }
                }
            )
        {
            return Err("binding 0 must be `aster_source: texture_2d<f32>`".into());
        }
        let sampler = self.bound_variable(1)?;
        if sampler.name.as_deref() != Some("aster_sampler")
            || sampler.space != AddressSpace::Handle
            || !matches!(
                module.types[sampler.ty].inner,
                TypeInner::Sampler { comparison: false }
            )
        {
            return Err("binding 1 must be `aster_sampler: sampler`".into());
        }
        self.validate_uniform(self.bound_variable(2)?)
    }
    fn bound_variable(&self, binding: u32) -> Result<&naga::GlobalVariable, String> {
        let module = &self.module;
        module
            .global_variables
            .iter()
            .map(|(_, variable)| variable)
            .find(|variable| {
                variable
                    .binding
                    .as_ref()
                    .is_some_and(|resource| resource.group == 0 && resource.binding == binding)
            })
            .ok_or_else(|| format!("missing @group(0) @binding({binding})"))
    }
    fn validate_uniform(&self, uniform: &naga::GlobalVariable) -> Result<(), String> {
        let module = &self.module;
        if uniform.name.as_deref() != Some("aster") || uniform.space != AddressSpace::Uniform {
            return Err("binding 2 must be `var<uniform> aster: AsterEffectUniforms`".into());
        }
        let ty = &module.types[uniform.ty];
        let TypeInner::Struct { members, span } = &ty.inner else {
            return Err("AsterEffectUniforms must be a struct".into());
        };
        if ty.name.as_deref() != Some("AsterEffectUniforms")
            || *span != Self::UNIFORM_SIZE
            || members.len() != 4
        {
            return Err("AsterEffectUniforms has an incompatible v1 memory layout".into());
        }
        let names = ["resolution", "time", "parameter_count", "parameters"];
        let offsets = [0, 8, 12, 16];
        if members
            .iter()
            .zip(names.into_iter().zip(offsets))
            .any(|(member, (name, offset))| {
                member.name.as_deref() != Some(name) || member.offset != offset
            })
        {
            return Err("AsterEffectUniforms fields or offsets do not match ABI v1".into());
        }
        if !module.is_vector(members[0].ty, VectorSize::Bi, ScalarKind::Float)
            || !module.is_scalar(members[1].ty, ScalarKind::Float)
            || !module.is_scalar(members[2].ty, ScalarKind::Uint)
        {
            return Err("AsterEffectUniforms scalar field types do not match ABI v1".into());
        }
        match module.types[members[3].ty].inner {
            TypeInner::Array {
                base,
                size: ArraySize::Constant(size),
                stride: 16,
            } if size.get() == Self::PARAMETER_VECTORS
                && module.is_vector(base, VectorSize::Quad, ScalarKind::Float) =>
            {
                Ok(())
            }
            _ => Err("parameters must be `array<vec4f, 16>`".into()),
        }
    }
}
