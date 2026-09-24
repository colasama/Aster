struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}

@group(0) @binding(0) var aster_source: texture_2d<f32>;
@group(0) @binding(1) var aster_sampler: sampler;
@group(0) @binding(2) var<uniform> aster: AsterEffectUniforms;

fn hash(point: vec2f) -> f32 {
    var state = bitcast<vec2u>(point);
    state = state ^ (state >> vec2u(15u));
    state = state * 1664525u + 1013904223u;
    state.x += state.y * 1664525u;
    state.y += state.x * 1664525u;
    state = state ^ (state >> vec2u(16u));
    state.x += state.y * 1664525u;
    state.y += state.x * 1664525u;
    state = state ^ (state >> vec2u(16u));
    return f32(state.x >> 8u) * (1.0 / 16777216.0);
}

@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f {
    let centered = uv * 2.0 - 1.0;
    let curvature = aster.parameters[0].x;
    let warped = centered * (1.0 + curvature * dot(centered, centered));
    let sample_uv = warped * 0.5 + 0.5;
    if (any(sample_uv < vec2f(0.0)) || any(sample_uv > vec2f(1.0))) {
        discard;
    }
    let source = textureSample(aster_source, aster_sampler, sample_uv);
    let scanline = sin(sample_uv.y * aster.resolution.y * 3.14159265);
    let scan = 1.0 - aster.parameters[1].x * (0.5 + 0.5 * scanline);
    let grain = (hash(sample_uv * aster.resolution + aster.time) - 0.5) * aster.parameters[2].x;
    return vec4f(max(source.rgb * scan + grain, vec3f(0.0)), source.a);
}
