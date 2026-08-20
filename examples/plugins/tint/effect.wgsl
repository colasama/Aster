struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}

@group(0) @binding(0) var aster_source: texture_2d<f32>;
@group(0) @binding(1) var aster_sampler: sampler;
@group(0) @binding(2) var<uniform> aster: AsterEffectUniforms;

@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f {
    let source = textureSample(aster_source, aster_sampler, uv);
    let amount = clamp(aster.parameters[0].x, 0.0, 1.0);
    let tint = aster.parameters[1].rgb;
    let luminance = dot(source.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(mix(source.rgb, luminance * tint, amount), source.a);
}
