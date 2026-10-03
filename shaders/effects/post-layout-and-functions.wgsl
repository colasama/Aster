

struct PostProcess {
  resolution_time_exposure: vec4f,
  color: vec4f,
  optical: vec4f,
  finish: vec4f,
  program: vec4f,
  grading: vec4f,
}

struct EffectOp {
  header: vec4f,
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var<uniform> settings: PostProcess;
@group(0) @binding(3) var<storage, read> effect_ops: array<EffectOp>;
@group(0) @binding(4) var lut_texture: texture_3d<f32>;
@group(0) @binding(5) var lut_sampler: sampler;
@group(0) @binding(6) var blur_scene: texture_2d<f32>;
@group(0) @binding(7) var glow_scene: texture_2d<f32>;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn sample_blur(uv: vec2f, radius: f32) -> vec3f {
  let pixel = vec2f(1.0) / settings.resolution_time_exposure.xy;
  let r = max(radius, 0.35);
  let max_lod = settings.program.z;
  if r <= 3.0 || max_lod <= 0.0 {
    // hdr_scene is single-mip; textureSampleLevel keeps this branch legal when callers
    // pass a per-pixel radius (non-uniform control flow rejects implicit-LOD samples).
    let offset = pixel * r;
    var color = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0).rgb * 0.2;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0), 0.0).rgb * 0.12;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0), 0.0).rgb * 0.12;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y), 0.0).rgb * 0.12;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y), 0.0).rgb * 0.12;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv + offset, 0.0).rgb * 0.08;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv - offset, 0.0).rgb * 0.08;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv + vec2f(offset.x, -offset.y), 0.0).rgb * 0.08;
    color += textureSampleLevel(hdr_scene, linear_sampler, uv + vec2f(-offset.x, offset.y), 0.0).rgb * 0.08;
    return color;
  }
  let lod = clamp(log2(r * (1.0 / 3.0)), 0.0, max_lod);
  let outer = pixel * r;
  let inner = outer * 0.55;
  var color = textureSampleLevel(blur_scene, linear_sampler, uv, lod).rgb * 0.22;
  color += textureSampleLevel(blur_scene, linear_sampler, uv + vec2f(outer.x, 0.0), lod).rgb * 0.1;
  color += textureSampleLevel(blur_scene, linear_sampler, uv - vec2f(outer.x, 0.0), lod).rgb * 0.1;
  color += textureSampleLevel(blur_scene, linear_sampler, uv + vec2f(0.0, outer.y), lod).rgb * 0.1;
  color += textureSampleLevel(blur_scene, linear_sampler, uv - vec2f(0.0, outer.y), lod).rgb * 0.1;
  color += textureSampleLevel(blur_scene, linear_sampler, uv + inner, lod).rgb * 0.095;
  color += textureSampleLevel(blur_scene, linear_sampler, uv - inner, lod).rgb * 0.095;
  color += textureSampleLevel(blur_scene, linear_sampler, uv + vec2f(inner.x, -inner.y), lod).rgb * 0.095;
  color += textureSampleLevel(blur_scene, linear_sampler, uv + vec2f(-inner.x, inner.y), lod).rgb * 0.095;
  return color;
}

// Samples the bright-pass pyramid at the same radius-to-LOD mapping as
// sample_blur. The chain stores blur(masked source), so the result is a
// physically placed halo with source chroma. The caller gates on
// settings.program.w, which flags that a masked chain is actually bound.
fn sample_masked_blur(uv: vec2f, radius: f32) -> vec3f {
  let lod = clamp(
    log2(max(radius, 1.0) * (1.0 / 3.0)),
    0.0,
    settings.program.z,
  );
  return textureSampleLevel(glow_scene, linear_sampler, uv, lod).rgb;
}

fn aces_tonemap(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

fn hash(position: vec2f) -> f32 {
  var state = bitcast<vec2u>(position);
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

fn value_noise(position: vec2f) -> f32 {
  let cell = floor(position);
  let local = fract(position);
  let blend = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(hash(cell), hash(cell + vec2f(1.0, 0.0)), blend.x),
    mix(hash(cell + vec2f(0.0, 1.0)), hash(cell + vec2f(1.0)), blend.x),
    blend.y,
  );
}

fn fractal_noise(position: vec2f) -> f32 {
  var frequency = 1.0;
  var amplitude = 0.5;
  var result = 0.0;
  for (var octave = 0u; octave < 5u; octave += 1u) {
    result += value_noise(position * frequency) * amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return result;
}

fn rotate2(value: vec2f, angle: f32) -> vec2f {
  let cosine = cos(angle);
  let sine = sin(angle);
  return vec2f(value.x * cosine - value.y * sine, value.x * sine + value.y * cosine);
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn median5(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 {
  var values = array<f32, 5>(a, b, c, d, e);
  for (var index = 1u; index < 5u; index += 1u) {
    var cursor = index;
    while cursor > 0u && values[cursor] < values[cursor - 1u] {
      let temporary = values[cursor];
      values[cursor] = values[cursor - 1u];
      values[cursor - 1u] = temporary;
      cursor -= 1u;
    }
  }
  return values[2u];
}

fn sample_alpha_cross(uv: vec2f, radius: f32) -> vec2f {
  let offset = vec2f(max(radius, 0.35)) / settings.resolution_time_exposure.xy;
  let center = textureSample(hdr_scene, linear_sampler, uv).a;
  let alpha_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).a;
  let alpha_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).a;
  let alpha_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).a;
  let alpha_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).a;
  return vec2f(
    min(center, min(min(alpha_a, alpha_b), min(alpha_c, alpha_d))),
    max(center, max(max(alpha_a, alpha_b), max(alpha_c, alpha_d))),
  );
}

fn effect_mask_value(effect: EffectOp, uv: vec2f, resolution: vec2f) -> f32 {
  let center = effect.header.yz;
  let half_size = max(
    vec2f(effect.header.w * resolution.x, effect.p0.x * resolution.y) * 0.5,
    vec2f(0.5),
  );
  let delta = (uv - center) * resolution;
  let ellipse_distance = (length(delta / half_size) - 1.0) * min(half_size.x, half_size.y);
  let rectangle_distance = max(abs(delta.x) - half_size.x, abs(delta.y) - half_size.y);
  let signed_distance = select(ellipse_distance, rectangle_distance, effect.p1.x > 0.5);
  let feather = max(effect.p0.y, 0.0001);
  var mask = 1.0 - smoothstep(-feather, feather, signed_distance);
  mask = select(mask, 1.0 - mask, effect.p0.w > 0.5);
  return mask * effect.p0.z;
}

