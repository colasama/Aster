use naga::{
    AddressSpace, ArraySize, Binding, ImageClass, ImageDimension, Module, ScalarKind, ShaderStage,
    TypeInner, VectorSize,
};

pub const EFFECT_ENTRY_POINT: &str = "aster_effect";
pub const EFFECT_PARAMETER_VECTORS: u32 = 16;
pub const EFFECT_UNIFORM_SIZE: u32 = 272;

pub(crate) fn validate_effect_abi(module: &Module) -> Result<(), String> {
    if module.entry_points.len() != 1 {
        return Err("v1 effects must expose exactly one shader entry point".into());
    }
    let entry = &module.entry_points[0];
    if entry.name != EFFECT_ENTRY_POINT || entry.stage != ShaderStage::Fragment {
        return Err(format!(
            "v1 effects require @fragment fn {EFFECT_ENTRY_POINT}"
        ));
    }
    if entry.function.arguments.len() != 1
        || !is_location(&entry.function.arguments[0].binding, 0)
        || !is_float_vector(module, entry.function.arguments[0].ty, VectorSize::Bi)
    {
        return Err("aster_effect must accept @location(0) uv: vec2f".into());
    }
    let Some(result) = &entry.function.result else {
        return Err("aster_effect must return @location(0) vec4f".into());
    };
    if !is_location(&result.binding, 0) || !is_float_vector(module, result.ty, VectorSize::Quad) {
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
    let source = bound_variable(module, 0)?;
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
    let sampler = bound_variable(module, 1)?;
    if sampler.name.as_deref() != Some("aster_sampler")
        || sampler.space != AddressSpace::Handle
        || !matches!(
            module.types[sampler.ty].inner,
            TypeInner::Sampler { comparison: false }
        )
    {
        return Err("binding 1 must be `aster_sampler: sampler`".into());
    }
    validate_uniform(module, bound_variable(module, 2)?)
}

fn bound_variable(module: &Module, binding: u32) -> Result<&naga::GlobalVariable, String> {
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

fn validate_uniform(module: &Module, uniform: &naga::GlobalVariable) -> Result<(), String> {
    if uniform.name.as_deref() != Some("aster") || uniform.space != AddressSpace::Uniform {
        return Err("binding 2 must be `var<uniform> aster: AsterEffectUniforms`".into());
    }
    let ty = &module.types[uniform.ty];
    let TypeInner::Struct { members, span } = &ty.inner else {
        return Err("AsterEffectUniforms must be a struct".into());
    };
    if ty.name.as_deref() != Some("AsterEffectUniforms")
        || *span != EFFECT_UNIFORM_SIZE
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
    if !is_float_vector(module, members[0].ty, VectorSize::Bi)
        || !is_scalar(module, members[1].ty, ScalarKind::Float)
        || !is_scalar(module, members[2].ty, ScalarKind::Uint)
    {
        return Err("AsterEffectUniforms scalar field types do not match ABI v1".into());
    }
    match module.types[members[3].ty].inner {
        TypeInner::Array {
            base,
            size: ArraySize::Constant(size),
            stride: 16,
        } if size.get() == EFFECT_PARAMETER_VECTORS
            && is_float_vector(module, base, VectorSize::Quad) =>
        {
            Ok(())
        }
        _ => Err("parameters must be `array<vec4f, 16>`".into()),
    }
}

fn is_location(binding: &Option<Binding>, expected: u32) -> bool {
    matches!(binding, Some(Binding::Location { location, .. }) if *location == expected)
}

fn is_float_vector(module: &Module, ty: naga::Handle<naga::Type>, size: VectorSize) -> bool {
    matches!(
        module.types[ty].inner,
        TypeInner::Vector {
            size: found,
            scalar: naga::Scalar {
                kind: ScalarKind::Float,
                width: 4
            }
        } if found == size
    )
}

fn is_scalar(module: &Module, ty: naga::Handle<naga::Type>, kind: ScalarKind) -> bool {
    matches!(
        module.types[ty].inner,
        TypeInner::Scalar(naga::Scalar { kind: found, width: 4 }) if found == kind
    )
}
