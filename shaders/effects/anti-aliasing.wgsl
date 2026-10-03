
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
override scale: u32 = 1u;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
fn sample_color(uv: vec2f) -> vec4f {
  return textureSampleLevel(source, linear_sampler, uv, 0.0);
}
fn luma(color: vec4f) -> f32 { return dot(color.rgb, vec3f(0.299, 0.587, 0.114)); }

@fragment fn fxaa(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let step = 1.0 / vec2f(textureDimensions(source));
  let uv = position.xy * step;
  let center = sample_color(uv);
  let nw = sample_color(uv + vec2f(-1.0, -1.0) * step);
  let ne = sample_color(uv + vec2f(1.0, -1.0) * step);
  let sw = sample_color(uv + vec2f(-1.0, 1.0) * step);
  let se = sample_color(uv + vec2f(1.0, 1.0) * step);
  let lights = vec4f(luma(nw), luma(ne), luma(sw), luma(se));
  let alphas = vec4f(nw.a, ne.a, sw.a, se.a);
  let lmin = min(luma(center), min(min(lights.x, lights.y), min(lights.z, lights.w)));
  let lmax = max(luma(center), max(max(lights.x, lights.y), max(lights.z, lights.w)));
  let amin = min(center.a, min(min(alphas.x, alphas.y), min(alphas.z, alphas.w)));
  let amax = max(center.a, max(max(alphas.x, alphas.y), max(alphas.z, alphas.w)));
  let alpha_edge = amax - amin > lmax - lmin;
  let values = select(lights, alphas, alpha_edge);
  let low = select(lmin, amin, alpha_edge);
  let high = select(lmax, amax, alpha_edge);
  if (high - low < max(0.0312, high * 0.125)) { return center; }
  let direction = vec2f(-((values.x + values.y) - (values.z + values.w)),
                         (values.x + values.z) - (values.y + values.w));
  let reduction = max(dot(values, vec4f(0.03125)), 0.0078125);
  let span = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduction), vec2f(-8.0), vec2f(8.0)) * step;
  let narrow = (sample_color(uv - span / 6.0) + sample_color(uv + span / 6.0)) * 0.5;
  let wide = narrow * 0.5 + (sample_color(uv - span * 0.5) + sample_color(uv + span * 0.5)) * 0.25;
  let wide_signal = select(luma(wide), wide.a, alpha_edge);
  return select(wide, narrow, wide_signal < low || wide_signal > high);
}

@fragment fn supersample(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let origin = vec2u(position.xy) * scale;
  var color = vec4f(0.0);
  for (var y = 0u; y < scale; y++) {
    for (var x = 0u; x < scale; x++) {
      color += textureLoad(source, vec2i(origin + vec2u(x, y)), 0);
    }
  }
  return color / f32(scale * scale);
}
