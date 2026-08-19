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
      default: {}
    }
  }

  let exposure = settings.resolution_time_exposure.w;
  let contrast = settings.color.x;
  let saturation = settings.color.y;
  let temperature = settings.color.z;
  let tint = settings.color.w;
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
  color = (color - vec3f(0.18)) * contrast + vec3f(0.18);
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
        let graded = pow(max(color, vec3f(0.0)), vec3f(0.92)) * vec3f(1.03, 1.0, 0.97);
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
