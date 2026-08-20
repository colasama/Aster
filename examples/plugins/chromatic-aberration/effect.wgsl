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
    let amount = aster.parameters[0].x;
    let angle = aster.parameters[1].x;
    let direction = vec2f(cos(angle), sin(angle));
    let offset = direction * amount / max(aster.resolution, vec2f(1.0));
    let center = textureSample(aster_source, aster_sampler, uv);
    let red = textureSample(aster_source, aster_sampler, uv + offset).r;
    let blue = textureSample(aster_source, aster_sampler, uv - offset).b;
    return vec4f(red, center.g, blue, center.a);
}
