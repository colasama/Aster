export const shapeShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: f32,
}

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.shape = shape;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var alpha = input.color.a;
  if input.shape > 0.5 {
    let distance = length((input.uv - vec2f(0.5)) * 2.0);
    alpha *= 1.0 - smoothstep(0.84, 1.0, distance);
    let halo = max(0.0, 1.0 - distance) * 0.48;
    return vec4f(input.color.rgb * (1.0 + halo), alpha);
  }
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  alpha *= smoothstep(0.0, 0.025, edge);
  return vec4f(input.color.rgb * alpha, alpha);
}
`;

export const imageShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) media_type: f32,
}

@group(0) @binding(0) var image_texture: texture_2d<f32>;
@group(0) @binding(1) var image_sampler: sampler;

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.media_type = shape;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(image_texture, image_sampler, input.uv);
  let source_alpha = select(sampled.a, 1.0, input.media_type > 1.5);
  let alpha = source_alpha * input.color.a;
  return vec4f(sampled.rgb * input.color.rgb * alpha, alpha);
}
`;

export const particleComputeShader = /* wgsl */ `
struct Simulation {
  time: f32,
  aspect: f32,
  count: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> simulation: Simulation;
@group(0) @binding(1) var<storage, read_write> particles: array<vec4f>;

fn hash(value: u32) -> f32 {
  var state = value * 747796405u + 2891336453u;
  state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  state = (state >> 22u) ^ state;
  return f32(state) / 4294967295.0;
}

@compute @workgroup_size(256)
fn compute_main(@builtin(global_invocation_id) global_id: vec3u) {
  let index = global_id.x;
  if f32(index) >= simulation.count { return; }
  let random_a = hash(index);
  let random_b = hash(index + 11731u);
  let random_c = hash(index + 97127u);
  let phase = simulation.time * (0.08 + random_c * 0.16) + random_a * 6.283185;
  let radius = 0.15 + sqrt(random_b) * 1.15;
  let x = cos(phase + radius * 3.0) * radius / max(simulation.aspect, 1.0);
  let y = sin(phase * 0.72) * radius * 0.66 + (random_c - 0.5) * 0.45;
  particles[index] = vec4f(x, y, 0.7 + random_a * 1.8, 0.05 + random_b * 0.34);
}
`;

export const particleRenderShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) opacity: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<vec4f>;

@vertex
fn vertex_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let particle = particles[instance];
  let size = particle.z / 900.0;
  var output: VertexOutput;
  output.position = vec4f(particle.xy + corners[vertex] * size, 0.0, 1.0);
  output.opacity = particle.w;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let color = vec3f(0.28, 0.58, 1.0) * input.opacity;
  return vec4f(color, input.opacity);
}
`;

export const textureCompositeShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(source_texture, source_sampler, input.uv);
}
`;

export const postProcessShader = /* wgsl */ `
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
  let offset = pixel * max(radius, 0.35);
  var color = textureSample(hdr_scene, linear_sampler, uv).rgb * 0.2;
  color += textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb * 0.12;
  color += textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb * 0.12;
  color += textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb * 0.12;
  color += textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb * 0.12;
  color += textureSample(hdr_scene, linear_sampler, uv + offset).rgb * 0.08;
  color += textureSample(hdr_scene, linear_sampler, uv - offset).rgb * 0.08;
  color += textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, -offset.y)).rgb * 0.08;
  color += textureSample(hdr_scene, linear_sampler, uv + vec2f(-offset.x, offset.y)).rgb * 0.08;
  return color;
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
  return fract(sin(dot(position, vec2f(12.9898, 78.233))) * 43758.5453);
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

fn hue_color(angle: f32) -> vec3f {
  return 0.5 + 0.5 * cos(angle + vec3f(0.0, 4.188790, 2.094395));
}

fn hue_rotate(color: vec3f, angle: f32) -> vec3f {
  let axis = normalize(vec3f(1.0));
  return color * cos(angle) + cross(axis, color) * sin(angle) + axis * dot(axis, color) * (1.0 - cos(angle));
}

fn sample_lut_tetrahedral(coordinate: vec3f) -> vec3f {
  let dimensions = textureDimensions(lut_texture, 0);
  let scaled = clamp(coordinate, vec3f(0.0), vec3f(1.0)) * vec3f(dimensions - vec3u(1u));
  let low = vec3u(floor(scaled));
  let high = min(low + vec3u(1u), dimensions - vec3u(1u));
  let fraction = fract(scaled);
  let c000 = textureLoad(lut_texture, vec3i(low), 0).rgb;
  let c100 = textureLoad(lut_texture, vec3i(vec3u(high.x, low.y, low.z)), 0).rgb;
  let c010 = textureLoad(lut_texture, vec3i(vec3u(low.x, high.y, low.z)), 0).rgb;
  let c001 = textureLoad(lut_texture, vec3i(vec3u(low.x, low.y, high.z)), 0).rgb;
  let c110 = textureLoad(lut_texture, vec3i(vec3u(high.x, high.y, low.z)), 0).rgb;
  let c101 = textureLoad(lut_texture, vec3i(vec3u(high.x, low.y, high.z)), 0).rgb;
  let c011 = textureLoad(lut_texture, vec3i(vec3u(low.x, high.y, high.z)), 0).rgb;
  let c111 = textureLoad(lut_texture, vec3i(high), 0).rgb;
  if fraction.x >= fraction.y {
    if fraction.y >= fraction.z {
      return c000 + fraction.x * (c100 - c000) + fraction.y * (c110 - c100) + fraction.z * (c111 - c110);
    }
    if fraction.x >= fraction.z {
      return c000 + fraction.x * (c100 - c000) + fraction.z * (c101 - c100) + fraction.y * (c111 - c101);
    }
    return c000 + fraction.z * (c001 - c000) + fraction.x * (c101 - c001) + fraction.y * (c111 - c101);
  }
  if fraction.x >= fraction.z {
    return c000 + fraction.y * (c010 - c000) + fraction.x * (c110 - c010) + fraction.z * (c111 - c110);
  }
  if fraction.y >= fraction.z {
    return c000 + fraction.y * (c010 - c000) + fraction.z * (c011 - c010) + fraction.x * (c111 - c011);
  }
  return c000 + fraction.z * (c001 - c000) + fraction.y * (c011 - c001) + fraction.x * (c111 - c011);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let resolution = settings.resolution_time_exposure.xy;
  let time = settings.resolution_time_exposure.z;
  let effect_count = u32(settings.program.x);
  var uv = input.uv;
  for (var index = 0u; index < 64u; index += 1u) {
    if (index >= effect_count) { break; }
    let effect = effect_ops[index];
    let code = u32(effect.header.x + 0.5);
    let centered = uv - vec2f(0.5);
    switch code {
      case 1u: {
        let blocks = max(effect.header.yz, vec2f(1.0));
        uv = (floor(uv * blocks) + vec2f(0.5)) / blocks;
      }
      case 5u: {
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = centered * aspect;
        let radius = max(effect.header.z / resolution.y, 0.0001);
        let falloff = clamp(1.0 - length(delta) / radius, 0.0, 1.0);
        uv = rotate2(delta, effect.header.y * falloff * falloff) / aspect + vec2f(0.5);
      }
      case 6u: {
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = centered * aspect;
        let radius = max(effect.header.y / resolution.y, 0.0001);
        let distance = length(delta) / radius;
        let falloff = pow(clamp(1.0 - distance, 0.0, 1.0), max(effect.header.w, 0.01));
        uv = delta * (1.0 - effect.header.z * falloff * 0.65) / aspect + vec2f(0.5);
      }
      case 7u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let phase = dot(uv * resolution, direction) / max(effect.header.z, 1.0) * 6.283185 + time * effect.p0.x;
        uv += vec2f(-direction.y, direction.x) * sin(phase) * effect.header.y / resolution;
      }
      case 24u: {
        let scale = max(effect.header.w, 0.001);
        uv = rotate2(centered, -effect.p0.x) / scale + vec2f(0.5) - effect.header.yz / resolution;
      }
      case 25u: {
        let position = uv * resolution / max(effect.header.z, 1.0) + vec2f(effect.p0.x + time * 0.1);
        let noise = vec2f(fractal_noise(position), fractal_noise(position + vec2f(31.7, 9.2))) - vec2f(0.5);
        uv += noise * effect.header.y / resolution;
      }
      case 26u: {
        let noise = vec2f(value_noise(uv * 13.0 + time), value_noise(uv * 17.0 - time)) - vec2f(0.5);
        uv += noise * effect.header.yz / resolution;
      }
      case 41u: {
        var reflected = rotate2(uv - vec2f(0.5), -effect.header.y);
        let mirror_line = effect.header.z - 0.5;
        reflected.x = mirror_line + abs(reflected.x - mirror_line);
        uv = rotate2(reflected, effect.header.y) + vec2f(0.5);
      }
      case 42u: {
        let tiled = (uv - vec2f(0.5)) * max(effect.header.yz, vec2f(0.01)) + vec2f(0.5);
        if effect.header.w > 0.5 {
          uv = abs(fract(tiled * 0.5) * 2.0 - vec2f(1.0));
        } else {
          uv = fract(tiled);
        }
      }
      case 47u: {
        let centered_uv = (uv - vec2f(0.5)) / max(effect.header.z, 0.01);
        let radius_squared = dot(centered_uv, centered_uv);
        uv = centered_uv * (1.0 + effect.header.y * radius_squared) + vec2f(0.5);
      }
      case 51u: {
        let segments = max(effect.header.y, 2.0);
        let rotation = effect.header.z;
        let center = vec2f(effect.header.w, effect.p0.x);
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = (uv - center) * aspect;
        let radius = length(delta) / max(effect.p0.y, 0.01);
        let sector = 6.283185 / segments;
        let triangle = abs(fract((atan2(delta.y, delta.x) - rotation) / sector + 0.5) * 2.0 - 1.0);
        let folded_angle = triangle * sector * 0.5 + rotation;
        uv = center + vec2f(cos(folded_angle), sin(folded_angle)) * radius / aspect;
      }
      case 66u: {
        let tile_size = max(effect.header.y, 1.0);
        let center = vec2f(effect.header.z, effect.header.w);
        let scale = max(effect.p0.y, 0.01);
        let pixel = rotate2((uv - center) * resolution, -effect.p0.x) / scale;
        let axial_x = (0.57735027 * pixel.x - 0.33333333 * pixel.y) / tile_size;
        let axial_z = 0.66666667 * pixel.y / tile_size;
        let cube = vec3f(axial_x, -axial_x - axial_z, axial_z);
        var rounded = round(cube);
        let difference = abs(rounded - cube);
        if difference.x > difference.y && difference.x > difference.z {
          rounded.x = -rounded.y - rounded.z;
        } else if difference.y > difference.z {
          rounded.y = -rounded.x - rounded.z;
        } else {
          rounded.z = -rounded.x - rounded.y;
        }
        let hex_pixel = vec2f(
          tile_size * 1.7320508 * (rounded.x + rounded.z * 0.5),
          tile_size * 1.5 * rounded.z,
        );
        let tiled_uv = center + rotate2(hex_pixel * scale, effect.p0.x) / resolution;
        uv = mix(uv, tiled_uv, effect.p0.z);
      }
      case 72u: {
        let center = vec2f(effect.header.w, effect.p0.x);
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = (uv - center) * aspect;
        let polar_uv = vec2f(
          fract(atan2(delta.y, delta.x) / 6.283185 + 0.5 + effect.p0.y / 6.283185),
          clamp(length(delta) * 2.0, 0.0, 1.0),
        );
        let rectangular_angle = (uv.x - center.x) * 6.283185 + effect.p0.y;
        let rectangular_radius = clamp(uv.y - center.y + 0.5, 0.0, 1.0) * 0.5;
        let rectangular_uv = center
          + vec2f(cos(rectangular_angle), sin(rectangular_angle)) * rectangular_radius / aspect;
        let remapped = select(polar_uv, rectangular_uv, effect.header.y > 0.5);
        uv = mix(uv, remapped, effect.header.z);
      }
      case 73u: {
        let shifted = uv - effect.header.yz / resolution;
        uv = select(clamp(shifted, vec2f(0.0), vec2f(1.0)), fract(shifted + vec2f(1.0)), effect.header.w > 0.5);
      }
      case 74u: {
        let center = effect.header.yz;
        let delta = (uv - center) * resolution;
        let distance = select(length(delta), max(abs(delta.x), abs(delta.y)), effect.p0.z > 0.5);
        let region = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        let magnified = center + delta / max(effect.header.w, 0.01) / resolution;
        uv = mix(uv, magnified, region);
      }
      case 75u: {
        let center = effect.header.yz;
        let delta = (uv - center) * resolution;
        let distance = length(delta);
        let direction = delta / max(distance, 0.0001);
        let falloff = 1.0 - smoothstep(effect.p0.y * 0.7, effect.p0.y, distance);
        let phase = distance / max(effect.p0.x, 1.0) * 6.283185 + effect.p0.z + time * effect.p0.w;
        uv += direction * sin(phase) * effect.header.w * falloff / resolution;
      }
      case 76u: {
        let upper_left = effect.header.yz;
        let upper_right = vec2f(effect.header.w, effect.p0.x);
        let lower_left = effect.p0.yz;
        let lower_right = vec2f(effect.p0.w, effect.p1.x);
        let top = mix(upper_left, upper_right, uv.x);
        let bottom = mix(lower_left, lower_right, uv.x);
        let pinned = mix(top, bottom, uv.y);
        uv = mix(uv, pinned, effect.p1.y);
      }
      default: {}
    }
  }

  let exposure = settings.resolution_time_exposure.w;
  let contrast = settings.color.x;
  let saturation = settings.color.y;
  let temperature = settings.color.z;
  let tint = settings.color.w;
  let pivot = settings.grading.x;
  let lift = settings.grading.y;
  let gain = settings.grading.z;
  let glow = settings.optical.x;
  let threshold = settings.optical.y;
  let blur_radius = settings.optical.z;
  let chromatic = settings.optical.w;
  let pixel = vec2f(1.0) / resolution;
  let chromatic_offset = pixel * chromatic * (uv - vec2f(0.5));

  let base = textureSample(hdr_scene, linear_sampler, uv);
  var alpha = base.a;
  var color = vec3f(
    textureSample(hdr_scene, linear_sampler, uv + chromatic_offset).r,
    base.g,
    textureSample(hdr_scene, linear_sampler, uv - chromatic_offset).b,
  );
  let linear_output = settings.program.y > 0.5;
  if linear_output && alpha > 0.00001 {
    color /= alpha;
  }
  let blurred = sample_blur(uv, blur_radius);
  let blur_mix = smoothstep(0.0, 1.0, blur_radius / 8.0);
  color = mix(color, blurred, blur_mix);
  let blurred_luminance = luminance(blurred);
  let highlight = max(blurred_luminance - threshold, 0.0) / max(blurred_luminance, 0.0001);
  color += blurred * highlight * glow;

  color *= exp2(exposure);
  color *= vec3f(1.0 + temperature * 0.16, 1.0 + tint * 0.08, 1.0 - temperature * 0.16);
  color += lift;
  color = (color - vec3f(pivot)) * contrast + vec3f(pivot);
  color *= gain;
  let gray = luminance(color);
  color = mix(vec3f(gray), color, saturation);
  color = pow(max(color, vec3f(0.0)), vec3f(1.0 / settings.finish.z));
  color = mix(color, vec3f(gray * 0.75 + 0.08), settings.finish.w);

  var effect_time = time;
  for (var index = 0u; index < 64u; index += 1u) {
    if (index >= effect_count) { break; }
    let effect = effect_ops[index];
    let code = u32(effect.header.x + 0.5);
    switch code {
      case 2u: {
        let levels = max(effect.header.y, 2.0);
        color = floor(clamp(color, vec3f(0.0), vec3f(1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
      }
      case 3u: {
        let mapped = mix(effect.header.yzw, effect.p0.yzw, clamp(luminance(color), 0.0, 1.0));
        color = mix(color, mapped, effect.p0.x);
      }
      case 4u: {
        color *= effect.header.yzw;
        color = mix(color, vec3f(luminance(color)), effect.p0.x);
      }
      case 8u: {
        let offset = vec2f(1.0) / resolution;
        let horizontal = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let vertical = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        var edge = length(vec2f(horizontal, vertical)) * 4.0;
        edge = mix(edge, 1.0 - edge, effect.header.y);
        color = mix(vec3f(edge), color, effect.header.z);
      }
      case 9u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let offset = direction * effect.header.z / resolution;
        let relief = luminance(textureSample(hdr_scene, linear_sampler, uv + offset).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - offset).rgb);
        let embossed = vec3f(0.5 + relief * effect.header.w);
        color = mix(embossed, color, effect.p0.x);
      }
      case 10u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let coordinate = dot(uv - vec2f(0.5), direction);
        let edge = effect.header.y - 0.5;
        let feather = effect.header.w / max(resolution.x, resolution.y);
        alpha *= 1.0 - smoothstep(edge - feather, edge + feather + 0.00001, coordinate);
      }
      case 11u: {
        var angle = atan2(uv.y - 0.5, uv.x - 0.5) - effect.header.z;
        angle = fract(angle / 6.283185 + 1.0);
        let feather = max(effect.header.w / 6.283185, 0.00001);
        alpha *= 1.0 - smoothstep(effect.header.y - feather, effect.header.y + feather, angle);
      }
      case 12u: {
        let level = luminance(color);
        let balance = clamp(level + effect.p0.y * 0.25, 0.0, 1.0);
        let shadow = hue_color(effect.header.y) * color * effect.header.z;
        let highlight_color = hue_color(effect.header.w) * color * effect.p0.x;
        color += mix(shadow, highlight_color, balance);
      }
      case 13u: {
        let cell = floor(input.position.xy / max(effect.header.y, 1.0));
        let selector = fract((cell.x + cell.y) * 0.5) * 2.0;
        let generated = mix(effect.p0.xyz, effect.p1.xyz, step(0.5, selector));
        color = mix(color, generated, effect.header.z);
      }
      case 14u: {
        let cell = fract(input.position.xy / max(effect.header.yz, vec2f(1.0)));
        let border = effect.header.w / max(effect.header.y, effect.header.z);
        let line = max(1.0 - step(border, cell.x), 1.0 - step(border, cell.y));
        color = mix(color, effect.p0.xyz, line);
      }
      case 15u: {
        let top = mix(effect.header.yzw, effect.p0.yzw, uv.x);
        let bottom = mix(effect.p1.yzw, effect.p2.yzw, uv.x);
        color = mix(color, mix(top, bottom, uv.y), effect.p0.x);
      }
      case 16u: {
        let position = input.position.xy / max(effect.header.w, 1.0) + vec2f(effect.p0.y + effect_time * 0.08);
        var generated = (fractal_noise(position) - 0.5) * effect.header.y + 0.5 + effect.header.z;
        generated = clamp(generated, 0.0, 1.0);
        color = vec3f(generated);
      }
      case 17u: {
        let low = sample_blur(uv, effect.header.z);
        let detail = color - low;
        let mask = step(effect.header.w, abs(luminance(detail)));
        color += detail * effect.header.y * mask;
      }
      case 18u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z)) * effect.header.y / resolution;
        color = (
          textureSample(hdr_scene, linear_sampler, uv - direction).rgb
          + textureSample(hdr_scene, linear_sampler, uv - direction * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv).rgb
          + textureSample(hdr_scene, linear_sampler, uv + direction * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv + direction).rgb
        ) * 0.2;
      }
      case 19u: {
        let delta = uv - vec2f(0.5);
        var total = textureSample(hdr_scene, linear_sampler, uv).rgb;
        for (var sample_index = 1u; sample_index < 5u; sample_index += 1u) {
          let amount = effect.header.y * f32(sample_index) * 0.25;
          let sample_uv = select(rotate2(delta, amount) + vec2f(0.5), uv - delta * amount, effect.header.z > 0.5);
          total += textureSample(hdr_scene, linear_sampler, sample_uv).rgb;
        }
        color = total * 0.2;
      }
      case 20u: {
        let distance = length(color - effect.header.yzw);
        let keep = smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        color.g *= 1.0 - (1.0 - keep) * effect.p0.z;
        alpha *= keep;
      }
      case 21u: {
        let level = luminance(color);
        let darker_keep = smoothstep(effect.header.z - effect.header.w, effect.header.z + effect.header.w, level);
        alpha *= select(darker_keep, 1.0 - darker_keep, effect.header.y > 0.5);
      }
      case 22u: {
        let key_channel = select(color.g, color.b, effect.header.y > 0.5);
        let other = select(max(color.r, color.b), max(color.r, color.g), effect.header.y > 0.5);
        let spill = max(key_channel - other * effect.header.w, 0.0) * effect.header.z;
        color = select(vec3f(color.r, color.g - spill, color.b), vec3f(color.r, color.g, color.b - spill), effect.header.y > 0.5);
      }
      case 23u: {
        let level = luminance(color);
        let shadow = 1.0 - smoothstep(0.0, 0.5, level);
        let highlight_weight = smoothstep(0.5, 1.0, level);
        let midtone = 1.0 - shadow - highlight_weight;
        let shift = effect.header.y * shadow + effect.header.z * midtone + effect.header.w * highlight_weight;
        color += vec3f(shift, 0.0, -shift);
      }
      case 27u: {
        let normalized = clamp((color - effect.header.y) / max(effect.header.z - effect.header.y, 0.0001), vec3f(0.0), vec3f(1.0));
        color = mix(vec3f(effect.p0.x), vec3f(effect.p0.y), pow(normalized, vec3f(1.0 / effect.header.w)));
      }
      case 28u: {
        let level = luminance(color);
        color += effect.header.y * (1.0 - level) + effect.header.w * level;
        color = (color - vec3f(0.5)) * (1.0 + effect.header.z) + vec3f(0.5);
      }
      case 29u: {
        let offset = vec2f(effect.header.y) / resolution;
        let a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb;
        let b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb;
        let c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb;
        let d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb;
        let maximum = max(max(a, b), max(c, d));
        let minimum = min(min(a, b), min(c, d));
        color = select(maximum, minimum, effect.header.z > 0.5);
      }
      case 30u: {
        effect_time = floor(effect_time * effect.header.y) / max(effect.header.y, 1.0);
      }
      case 31u: {
        color = hue_rotate(color, effect.header.y);
        let level = luminance(color);
        color = mix(vec3f(level), color, effect.header.z) + effect.header.w;
      }
      case 32u: {
        let domain_min = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        let domain_max = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        let coordinate = clamp((color - domain_min) / max(domain_max - domain_min, vec3f(0.0001)), vec3f(0.0), vec3f(1.0));
        let graded = select(
          textureSampleLevel(lut_texture, lut_sampler, coordinate, 0.0).rgb,
          sample_lut_tetrahedral(coordinate),
          effect.header.z > 0.5,
        );
        color = mix(color, graded, effect.header.y);
      }
      case 33u: {
        let offset = vec2f(max(effect.header.y, 0.5)) / resolution;
        let center_level = luminance(color);
        var weighted = color;
        var total_weight = 1.0;
        let sample_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb;
        let sample_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb;
        let sample_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb;
        let sample_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb;
        let threshold = max(effect.header.z, 0.0001);
        let weight_a = exp(-abs(luminance(sample_a) - center_level) / threshold);
        let weight_b = exp(-abs(luminance(sample_b) - center_level) / threshold);
        let weight_c = exp(-abs(luminance(sample_c) - center_level) / threshold);
        let weight_d = exp(-abs(luminance(sample_d) - center_level) / threshold);
        weighted += sample_a * weight_a + sample_b * weight_b + sample_c * weight_c + sample_d * weight_d;
        total_weight += weight_a + weight_b + weight_c + weight_d;
        color = weighted / total_weight;
      }
      case 34u: {
        let offset = vec2f(effect.header.y * 180.0, effect.header.y * 90.0) / resolution;
        var echo_color = color;
        var echo_weight = 1.0;
        let echo_count = min(u32(effect.header.z), 8u);
        for (var echo_index = 1u; echo_index <= 8u; echo_index += 1u) {
          if (echo_index > echo_count) { break; }
          let weight = pow(effect.header.w, f32(echo_index));
          let sample_color = textureSample(hdr_scene, linear_sampler, uv + offset * f32(echo_index)).rgb;
          if effect.p0.x < 0.5 {
            echo_color += sample_color * weight;
          } else if effect.p0.x < 1.5 {
            echo_color = max(echo_color, sample_color * weight);
          } else if effect.p0.x < 2.5 {
            echo_color = vec3f(1.0) - (vec3f(1.0) - echo_color) * (vec3f(1.0) - sample_color * weight);
          } else {
            echo_color += sample_color * weight;
            echo_weight += weight;
          }
        }
        color = select(echo_color, echo_color / max(echo_weight, 0.0001), effect.p0.x > 2.5);
      }
      case 35u: {
        let trail_offset = vec2f(effect.header.z * 150.0, effect.header.z * 45.0) / resolution;
        var trail = color;
        var trail_weight = 1.0;
        let trail_count = min(u32(effect.header.y), 6u);
        for (var trail_index = 1u; trail_index <= 6u; trail_index += 1u) {
          if (trail_index > trail_count) { break; }
          let weight = pow(effect.header.w, f32(trail_index));
          trail += textureSample(hdr_scene, linear_sampler, uv + trail_offset * f32(trail_index) / 6.0).rgb * weight;
          trail_weight += weight;
        }
        color = trail / trail_weight;
      }
      case 36u: {
        let cell_size = max(5.0, 42.0 / max(effect.header.y, 0.1));
        let cell = floor(input.position.xy / cell_size);
        let random = hash(cell + vec2f(effect.p0.y));
        let life = fract(time / max(effect.header.z, 0.01) + random);
        let local = fract(input.position.xy / cell_size);
        let center = vec2f(hash(cell + vec2f(19.3)), hash(cell + vec2f(71.7)));
        let gravity_offset = vec2f(0.0, effect.p0.x * life * life * 0.2);
        let distance = length(local - center - gravity_offset);
        let particle = (1.0 - smoothstep(0.04, 0.16, distance)) * (1.0 - life) * min(effect.header.w, 4.0);
        color += vec3f(0.35, 0.65, 1.0) * particle;
        alpha = max(alpha, particle);
      }
      case 37u: {
        color = mix(color, effect.header.yzw, effect.p0.x);
      }
      case 38u: {
        var inverted = vec3f(1.0) - color;
        if effect.header.y > 0.5 && effect.header.y < 1.5 { inverted = vec3f(1.0 - color.r, color.g, color.b); }
        if effect.header.y > 1.5 && effect.header.y < 2.5 { inverted = vec3f(color.r, 1.0 - color.g, color.b); }
        if effect.header.y > 2.5 { inverted = vec3f(color.r, color.g, 1.0 - color.b); }
        color = mix(color, inverted, effect.header.z);
      }
      case 39u: {
        let value = smoothstep(effect.header.y - effect.header.z, effect.header.y + effect.header.z, luminance(color));
        color = vec3f(value);
      }
      case 40u: {
        let monochrome = hash(input.position.xy + vec2f(time * 113.0)) - 0.5;
        let colored = vec3f(
          monochrome,
          hash(input.position.yx + vec2f(time * 157.0, 19.0)) - 0.5,
          hash(input.position.xy + vec2f(47.0, time * 193.0)) - 0.5,
        );
        color += select(vec3f(monochrome), colored, effect.header.z > 0.5) * effect.header.y;
      }
      case 43u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let coordinate = dot(input.position.xy, direction);
        let stripe = fract(coordinate / max(effect.header.w, 1.0));
        let feather = effect.p0.x / max(effect.header.w, 1.0);
        alpha *= 1.0 - smoothstep(effect.header.y - feather, effect.header.y + feather, stripe);
      }
      case 44u: {
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let ramp = clamp(dot(uv - vec2f(0.5), direction) + 0.5, 0.0, 1.0);
        let gradient = mix(effect.header.yzw, effect.p0.yzw, ramp);
        color = mix(color, gradient, effect.p1.x);
      }
      case 45u: {
        let direction = vec2f(cos(effect.p0.y), sin(effect.p0.y));
        let shadow_uv = uv - direction * effect.p0.z / resolution;
        let soft = vec2f(max(effect.p0.w, 0.5)) / resolution;
        var shadow_alpha = textureSample(hdr_scene, linear_sampler, shadow_uv).a * 0.4;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha *= effect.p0.x;
        color += effect.header.yzw * shadow_alpha * (1.0 - alpha);
        alpha = max(alpha, shadow_alpha);
      }
      case 46u: {
        let level = clamp(luminance(color), 0.0, 1.0);
        let lower = mix(effect.header.yzw, effect.p0.xyz, smoothstep(0.0, 0.5, level));
        let upper = mix(effect.p0.xyz, vec3f(effect.p0.w, effect.p1.x, effect.p1.y), smoothstep(0.5, 1.0, level));
        color = mix(color, select(lower, upper, level > 0.5), effect.p1.z);
      }
      case 48u: {
        let monochrome = dot(color, effect.header.yzw);
        let tinted = vec3f(monochrome) * effect.p0.yzw;
        color = select(vec3f(monochrome), tinted, effect.p0.x > 0.5);
      }
      case 49u: {
        let phase = fract(luminance(color) + effect.header.y / 6.283185);
        var palette = hue_color(phase * 6.283185);
        if effect.header.z > 0.5 && effect.header.z < 1.5 {
          palette = vec3f(
            smoothstep(0.0, 0.55, phase),
            smoothstep(0.18, 0.72, phase) * (1.0 - smoothstep(0.72, 1.0, phase)),
            smoothstep(0.72, 1.0, phase) * 0.35,
          );
        } else if effect.header.z > 1.5 {
          palette = mix(vec3f(0.01, 0.08, 0.22), vec3f(0.12, 0.9, 1.0), smoothstep(0.0, 1.0, phase));
        }
        palette = mix(vec3f(luminance(palette)), palette, effect.header.w);
        color = mix(color, palette, effect.p0.x);
      }
      case 50u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let normal = vec2f(-sin(effect.header.w), cos(effect.header.w));
        let distance = abs(dot((uv - center) * resolution, normal));
        let band = pow(clamp(1.0 - distance / max(effect.p0.x, 1.0), 0.0, 1.0), max(effect.p0.z, 0.1));
        color += effect.p1.xyz * band * effect.p0.y * effect.p0.w;
      }
      case 52u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let offset = direction * max(effect.header.z, 0.25) / resolution;
        let forward = textureSample(hdr_scene, linear_sampler, uv + offset).a;
        let backward = textureSample(hdr_scene, linear_sampler, uv - offset).a;
        let edge = (backward - forward) * effect.header.w;
        let beveled = color
          + effect.p0.yzw * max(edge, 0.0)
          - (vec3f(1.0) - effect.p1.xyz) * max(-edge, 0.0);
        color = mix(color, beveled, effect.p0.x);
      }
      case 53u: {
        let offset = vec2f(max(effect.header.y, 0.25)) / resolution;
        let left = luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let right = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb);
        let up = luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        let down = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb);
        let normal = normalize(vec3f((left - right) * effect.header.z, (up - down) * effect.header.z, 1.0));
        let light = normalize(vec3f(cos(effect.p0.x), sin(effect.p0.x), max(effect.p0.y, 0.05)));
        let refracted = textureSample(hdr_scene, linear_sampler, uv + normal.xy * effect.header.w / resolution).rgb;
        let diffuse = max(dot(normal, light), 0.0);
        let specular = pow(diffuse, 24.0) * 0.8;
        let glass = refracted * (0.42 + diffuse * 0.72) + vec3f(specular);
        color = mix(color, glass, effect.p0.z);
      }
      case 54u: {
        let offset = vec2f(1.0) / resolution;
        let horizontal = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let vertical = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        let levels = max(effect.header.z, 2.0);
        let posterized = floor(clamp(color, vec3f(0.0), vec3f(1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
        let ink = smoothstep(effect.header.y, effect.header.y + effect.header.w, length(vec2f(horizontal, vertical)));
        color = mix(color, posterized * (1.0 - ink), effect.p0.x);
      }
      case 55u: {
        let solarized = select(color, max(vec3f(0.0), vec3f(1.0) - color), color > vec3f(effect.header.y));
        color = mix(color, solarized, effect.header.z);
      }
      case 56u: {
        let radius = max(abs(effect.header.y) + effect.header.z, 0.25);
        let offset = vec2f(radius) / resolution;
        let alpha_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).a;
        let alpha_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).a;
        let alpha_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).a;
        let alpha_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).a;
        let contracted = min(alpha, min(min(alpha_a, alpha_b), min(alpha_c, alpha_d)));
        let expanded = max(alpha, max(max(alpha_a, alpha_b), max(alpha_c, alpha_d)));
        let matte = select(expanded, contracted, effect.header.y >= 0.0);
        let amount = abs(effect.header.y) / max(abs(effect.header.y) + effect.header.z, 0.0001);
        alpha = mix(alpha, matte, amount);
      }
      case 57u: {
        let offset = vec2f(max(effect.header.y, 0.0)) / resolution;
        color = (
          textureSample(hdr_scene, linear_sampler, uv).rgb
          + textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb
        ) * 0.2;
      }
      case 58u: {
        var lens_color = vec3f(0.0);
        var lens_weight = 0.0;
        for (var lens_index = 0u; lens_index < 8u; lens_index += 1u) {
          let angle = effect.header.z + f32(lens_index) * 0.785398;
          let sample_uv = uv + vec2f(cos(angle), sin(angle)) * effect.header.y / resolution;
          let lens_sample = textureSample(hdr_scene, linear_sampler, sample_uv).rgb;
          let highlight = 1.0 + max(luminance(lens_sample) - effect.header.w, 0.0) * effect.p0.x;
          lens_color += lens_sample * highlight;
          lens_weight += highlight;
        }
        color = lens_color / max(lens_weight, 0.0001);
      }
      case 59u: {
        let distance = length(color - effect.header.yzw);
        let selection = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        var replacement = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        if effect.p1.y > 0.5 {
          replacement *= luminance(color) / max(luminance(replacement), 0.0001);
        }
        color = mix(color, replacement, selection);
      }
      case 60u: {
        let distance = length(color - effect.header.yzw);
        let selection = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        let isolated = mix(vec3f(luminance(color)), color, selection);
        color = mix(color, isolated, effect.p0.z);
      }
      case 61u: {
        let level = luminance(color);
        var matte = smoothstep(effect.header.y - effect.header.w, effect.header.y + effect.header.w, level);
        matte *= 1.0 - smoothstep(effect.header.z - effect.header.w, effect.header.z + effect.header.w, level);
        matte = select(matte, 1.0 - matte, effect.p0.x > 0.5);
        alpha *= matte;
      }
      case 62u: {
        let position = input.position.xy / max(effect.header.z, 1.0) + vec2f(effect.p0.x + time * 0.08);
        let roughness = fractal_noise(position);
        let direction = normalize(vec2f(
          value_noise(position + vec2f(17.0, 3.0)) - 0.5,
          value_noise(position + vec2f(5.0, 29.0)) - 0.5,
        ) + vec2f(0.0001));
        let rough_alpha = textureSample(
          hdr_scene,
          linear_sampler,
          uv + direction * (roughness - 0.5) * effect.header.y / resolution,
        ).a;
        let detail = clamp(effect.header.w / 5.0, 0.0, 1.0);
        let erosion = smoothstep(0.5 - effect.p0.y, 0.5 + effect.p0.y, roughness) * detail;
        alpha = mix(alpha, min(alpha, rough_alpha), erosion);
      }
      case 63u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let direction = normalize(uv - center + vec2f(0.0001));
        let ray = direction * effect.header.w / resolution;
        var burst = vec3f(0.0);
        for (var burst_index = 1u; burst_index <= 5u; burst_index += 1u) {
          burst += textureSample(hdr_scene, linear_sampler, uv - ray * f32(burst_index) * 0.2).rgb;
        }
        burst = max(burst * 0.2 - color * 0.35, vec3f(0.0));
        let burst_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, color + burst * burst_color * effect.p0.x, effect.p0.y);
      }
      case 64u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let direction = normalize(uv - center + vec2f(0.0001));
        let shadow_uv = uv - direction * effect.header.w / resolution;
        let soft = vec2f(max(effect.p0.y, 0.5)) / resolution;
        var shadow_alpha = textureSample(hdr_scene, linear_sampler, shadow_uv).a * 0.4;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha *= effect.p0.x;
        let shadow_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color += shadow_color * shadow_alpha * (1.0 - alpha);
        alpha = max(alpha, shadow_alpha);
      }
      case 65u: {
        let grid_size = max(effect.header.y, 2.0);
        let twist = effect.p0.x;
        let screen_center = resolution * 0.5;
        let twisted_pixel = rotate2(input.position.xy - screen_center, -twist) + screen_center;
        let cell = floor(twisted_pixel / grid_size);
        let local = fract(twisted_pixel / grid_size) - vec2f(0.5);
        let scatter_direction = vec2f(hash(cell) - 0.5, hash(cell + vec2f(37.1, 91.7)) - 0.5);
        let cell_center = (cell + vec2f(0.5)) * grid_size + scatter_direction * effect.header.w;
        let sample_pixel = rotate2(cell_center - screen_center, twist) + screen_center;
        let sampled = textureSample(hdr_scene, linear_sampler, sample_pixel / resolution).rgb;
        let normalized_radius = length(local) * 2.0 / max(effect.header.z, 0.001);
        let sphere = 1.0 - smoothstep(0.96, 1.0, normalized_radius);
        let lighting = 0.35 + 0.65 * sqrt(max(1.0 - normalized_radius * normalized_radius, 0.0));
        let rebuilt = sampled * lighting * sphere;
        color = mix(color, rebuilt, effect.p0.y);
        alpha = mix(alpha, alpha * sphere, effect.p0.y);
      }
      case 67u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let segment = end - start;
        let progress = clamp(dot(input.position.xy - start, segment) / max(dot(segment, segment), 0.0001), 0.0, 1.0);
        let distance = length(input.position.xy - (start + segment * progress));
        let beam = 1.0 - smoothstep(effect.p0.y, effect.p0.y + effect.p0.z + 0.0001, distance);
        let beam_color = mix(effect.p1.xyz, effect.p2.xyz, progress);
        color += beam_color * beam * effect.p0.w * effect.p1.w;
        alpha = max(alpha, beam * effect.p1.w);
      }
      case 68u: {
        let center = effect.header.yz * resolution;
        let distance = length(input.position.xy - center);
        let spacing = max(min(resolution.x, resolution.y) / max(effect.header.w, 0.1), 1.0);
        let wave_phase = fract((distance - effect.p0.x * effect_time) / spacing);
        let wave_distance = min(wave_phase, 1.0 - wave_phase) * spacing;
        let wave = 1.0 - smoothstep(effect.p0.y, effect.p0.y + 1.5, wave_distance);
        let radial_fade = mix(1.0, clamp(1.0 - distance / max(min(resolution.x, resolution.y) * 0.65, 1.0), 0.0, 1.0), effect.p0.w);
        let wave_color = effect.p1.xyz * wave * radial_fade * effect.p0.z;
        color += wave_color * effect.p1.w;
        alpha = max(alpha, wave * radial_fade * effect.p1.w);
      }
      case 69u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let segment = end - start;
        let segment_length = max(length(segment), 0.0001);
        let direction = segment / segment_length;
        let normal = vec2f(-direction.y, direction.x);
        let progress = clamp(dot(input.position.xy - start, direction) / segment_length, 0.0, 1.0);
        let noise_position = vec2f(progress * max(effect.p0.z, 1.0), effect.p0.w + effect_time * 0.7);
        let jagged = (fractal_noise(noise_position) - 0.5) * effect.p0.y * sin(progress * 3.14159265);
        let bolt_point = start + segment * progress + normal * jagged;
        let distance = length(input.position.xy - bolt_point);
        let core = 1.0 - smoothstep(effect.p1.x, effect.p1.x + 1.25, distance);
        let halo = 1.0 - smoothstep(effect.p1.x, effect.p1.x + effect.p1.y + 0.0001, distance);
        let bolt_color = vec3f(effect.p1.z, effect.p1.w, effect.p2.x);
        let lightning = core * 2.0 + halo * 0.7;
        color += bolt_color * lightning * effect.p2.y;
        alpha = max(alpha, clamp(lightning, 0.0, 1.0) * effect.p2.y);
      }
      case 70u: {
        let center = effect.header.yz * resolution;
        let distance = length(input.position.xy - center);
        let feather = max(effect.p0.y, 0.75);
        let ring_distance = abs(distance - effect.header.w);
        let ring = 1.0 - smoothstep(effect.p0.x, effect.p0.x + feather, ring_distance);
        let disk = 1.0 - smoothstep(effect.header.w, effect.header.w + feather, distance);
        let shape = select(ring, disk, effect.p0.z > 0.5);
        let circle_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        let amount = shape * effect.p1.z * effect.p1.w;
        color += circle_color * amount;
        alpha = max(alpha, amount);
      }
      case 71u: {
        let center = effect.header.yz * resolution;
        let delta = input.position.xy - center;
        let distance = length(delta);
        let angle = atan2(delta.y, delta.x) + effect.p0.y;
        let spoke = pow(max(cos(angle * effect.header.w * 0.5), 0.0), max(effect.p0.z, 0.5));
        let radial = 1.0 - smoothstep(effect.p0.x * 0.08, effect.p0.x, distance);
        let center_glow = exp(-distance / max(effect.p0.x * 0.12, 1.0));
        let burst = (spoke * radial + center_glow * 0.7) * effect.p0.w;
        color += effect.p1.xyz * burst * effect.p1.w;
        alpha = max(alpha, clamp(burst, 0.0, 1.0) * effect.p1.w);
      }
      case 77u: {
        let center = effect.header.yz * resolution;
        let delta = input.position.xy - center;
        let distance = length(delta);
        let scale = max(effect.p0.x, 1.0);
        let halo = exp(-distance / (scale * 0.42));
        let ring = 1.0 - smoothstep(3.0, 12.0, abs(distance - scale * 0.72));
        let streak_direction = vec2f(cos(effect.p0.y), sin(effect.p0.y));
        let streak_normal = vec2f(-streak_direction.y, streak_direction.x);
        let across = abs(dot(delta, streak_normal));
        let along = abs(dot(delta, streak_direction));
        let anamorphic = 1.0 - smoothstep(1.5, 8.0 + effect.p0.z * 9.0, across);
        let streak = anamorphic * exp(-along / (scale * (1.2 + effect.p0.z)));
        let lens_axis = resolution * vec2f(0.5) - center;
        let ghost_a = exp(-length(input.position.xy - (center + lens_axis * 0.72)) / (scale * 0.16));
        let ghost_b = exp(-length(input.position.xy - (center + lens_axis * 1.34)) / (scale * 0.1));
        let flare = halo * 1.4 + ring * 0.42 + streak * 0.6 + ghost_a * 0.55 + ghost_b * 0.38;
        let flare_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += flare_color * flare * effect.header.w * effect.p1.z;
        alpha = max(alpha, clamp(flare, 0.0, 1.0) * effect.p1.z);
      }
      case 78u: {
        let position = input.position.xy / max(effect.header.y, 1.0) + vec2f(effect.header.w * 0.07 + effect_time * 0.03);
        let base_cell = floor(position);
        let local = fract(position);
        var nearest = 10.0;
        var second_nearest = 10.0;
        for (var cell_y = -1; cell_y <= 1; cell_y += 1) {
          for (var cell_x = -1; cell_x <= 1; cell_x += 1) {
            let neighbor = vec2f(f32(cell_x), f32(cell_y));
            let cell = base_cell + neighbor;
            let point = neighbor + vec2f(hash(cell), hash(cell + vec2f(71.3, 19.7)));
            let candidate = length(point - local);
            if candidate < nearest {
              second_nearest = nearest;
              nearest = candidate;
            } else if candidate < second_nearest {
              second_nearest = candidate;
            }
          }
        }
        var cell_value = smoothstep(0.02, 0.18, second_nearest - nearest);
        if effect.p0.x > 0.5 && effect.p0.x < 1.5 {
          cell_value = pow(clamp(1.0 - nearest, 0.0, 1.0), max(effect.header.z, 0.01));
        } else if effect.p0.x > 1.5 {
          cell_value = 1.0 - smoothstep(0.12, 0.72, nearest * max(effect.header.z, 0.01));
        } else {
          cell_value = pow(cell_value, 1.0 / max(effect.header.z, 0.01));
        }
        cell_value = select(cell_value, 1.0 - cell_value, effect.p0.y > 0.5);
        let cell_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        let border_color = effect.p1.yzw;
        color = mix(color, mix(border_color, cell_color, cell_value), effect.p2.x);
      }
      case 79u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let normal = vec2f(-direction.y, direction.x);
        let field = vec2f(
          dot(input.position.xy, normal),
          dot(input.position.xy, direction) - effect_time * effect.header.z,
        );
        let grid = vec2f(max(24.0 / max(effect.header.y, 0.05), 4.0), max(effect.p0.x * 2.4, 40.0));
        let cell = floor(field / grid);
        let random_offset = vec2f(hash(cell + vec2f(effect.p0.z)), hash(cell + vec2f(effect.p0.z + 47.0)));
        let local = fract(field / grid + random_offset) - vec2f(0.5);
        let cross_distance = abs(local.x * grid.x);
        let along_distance = abs(local.y * grid.y);
        let streak = (1.0 - smoothstep(effect.p0.y, effect.p0.y + 1.0, cross_distance))
          * (1.0 - smoothstep(effect.p0.x * 0.5, effect.p0.x * 0.5 + 2.0, along_distance));
        let rain_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += rain_color * streak * effect.p1.z;
        alpha = max(alpha, streak * effect.p1.z);
      }
      case 80u: {
        let grid_size = max(48.0 / max(effect.header.y, 0.05), 7.0);
        let animated = input.position.xy
          - vec2f(effect.p0.x * effect_time, effect.header.z * effect_time)
          + vec2f(sin(input.position.y / 90.0 + effect_time) * effect.p0.y, 0.0);
        let cell = floor(animated / grid_size);
        let depth = 0.35 + hash(cell + vec2f(effect.p0.z)) * 0.65;
        let center = vec2f(
          hash(cell + vec2f(effect.p0.z + 11.0)),
          hash(cell + vec2f(effect.p0.z + 83.0)),
        );
        let local = fract(animated / grid_size);
        let distance = length(local - center) * grid_size;
        let radius = effect.header.w * depth;
        let flake = (1.0 - smoothstep(radius, radius + 1.25, distance)) * depth;
        let snow_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += snow_color * flake * effect.p1.z;
        alpha = max(alpha, flake * effect.p1.z);
      }
      default: {}
    }
  }

  let centered = uv * 2.0 - vec2f(1.0);
  let vignette = smoothstep(1.2, 0.18, dot(centered, centered));
  color *= mix(1.0 - settings.finish.x, 1.0, vignette);
  let noise = hash(input.position.xy + vec2f(effect_time * 91.7)) - 0.5;
  color += noise * settings.finish.y;
  if linear_output {
    return vec4f(max(color, vec3f(0.0)) * alpha, alpha);
  }
  return vec4f(aces_tonemap(color) * alpha, alpha);
}
`;
