export const shapeShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: f32,
  @location(3) normal: vec3f,
  @location(4) material: vec4f,
  @location(5) world_position: vec3f,
}

struct SceneLighting {
  direction_intensity: vec4f,
  color_ambient: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
  shadow_x_scale: vec4f,
  shadow_y_scale: vec4f,
  shadow_z_scale: vec4f,
  shadow_center_bias: vec4f,
}

@group(0) @binding(0) var<uniform> lighting: SceneLighting;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;

fn shadow_position(world_position: vec3f) -> vec3f {
  let relative = world_position - lighting.shadow_center_bias.xyz;
  return vec3f(
    dot(relative, lighting.shadow_x_scale.xyz) * lighting.shadow_x_scale.w,
    dot(relative, lighting.shadow_y_scale.xyz) * lighting.shadow_y_scale.w,
    0.5 - dot(relative, lighting.shadow_z_scale.xyz) * lighting.shadow_z_scale.w,
  );
}

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
  @location(4) normal: vec3f,
  @location(5) material: vec4f,
  @location(6) world_position: vec3f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.shape = shape;
  output.normal = normal;
  output.material = material;
  output.world_position = world_position;
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
  var color = input.color.rgb;
  if input.material.w > 0.5 {
    let normal = normalize(input.normal);
    let to_light = lighting.position_kind.xyz - input.world_position;
    let distance_to_light = max(length(to_light), 0.001);
    let directional = lighting.position_kind.w < 0.5;
    let light_direction = select(normalize(to_light), normalize(lighting.direction_intensity.xyz), directional);
    let normalized_distance = distance_to_light / max(lighting.range_cone.x, 1.0);
    var attenuation = select(1.0 / (1.0 + normalized_distance * normalized_distance * 4.0), 1.0, directional);
    if lighting.position_kind.w > 1.5 {
      let from_light = normalize(input.world_position - lighting.position_kind.xyz);
      let cone = dot(from_light, normalize(lighting.direction_intensity.xyz));
      attenuation *= smoothstep(lighting.range_cone.y, min(1.0, lighting.range_cone.y + 0.08), cone);
    }
    let diffuse_weight = max(dot(normal, light_direction), 0.0);
    let view_direction = vec3f(0.0, 0.0, 1.0);
    let half_direction = normalize(light_direction + view_direction);
    let roughness = clamp(input.material.y, 0.04, 1.0);
    let metallic = clamp(input.material.x, 0.0, 1.0);
    let specular_power = mix(160.0, 4.0, roughness);
    let fresnel = mix(vec3f(0.04), color, metallic);
    let specular = fresnel * pow(max(dot(normal, half_direction), 0.0), specular_power);
    let radiance = lighting.color_ambient.rgb * lighting.direction_intensity.w * attenuation;
    let shadow_coordinate = shadow_position(input.world_position);
    let shadow_uv = vec2f(shadow_coordinate.x * 0.5 + 0.5, 0.5 - shadow_coordinate.y * 0.5);
    let inside_shadow_map = all(shadow_uv >= vec2f(0.0)) && all(shadow_uv <= vec2f(1.0))
      && shadow_coordinate.z >= 0.0 && shadow_coordinate.z <= 1.0;
    var visibility = 1.0;
    if inside_shadow_map && lighting.position_kind.w != 1.0 {
      let comparison = textureSampleCompareLevel(
        shadow_map,
        shadow_sampler,
        shadow_uv,
        shadow_coordinate.z - lighting.shadow_center_bias.w,
      );
      visibility = mix(0.32, 1.0, comparison);
    }
    let diffuse = color * (1.0 - metallic) * diffuse_weight * radiance * visibility;
    color = color * lighting.color_ambient.w + diffuse + specular * radiance * visibility;
    color += input.color.rgb * max(input.material.z, 0.0);
  }
  return vec4f(color * alpha, alpha);
}
`;

export const shadowShader = /* wgsl */ `
struct SceneLighting {
  direction_intensity: vec4f,
  color_ambient: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
  shadow_x_scale: vec4f,
  shadow_y_scale: vec4f,
  shadow_z_scale: vec4f,
  shadow_center_bias: vec4f,
}

@group(0) @binding(0) var<uniform> lighting: SceneLighting;

@vertex
fn vertex_main(@location(6) world_position: vec3f) -> @builtin(position) vec4f {
  let relative = world_position - lighting.shadow_center_bias.xyz;
  let x = dot(relative, lighting.shadow_x_scale.xyz) * lighting.shadow_x_scale.w;
  let y = dot(relative, lighting.shadow_y_scale.xyz) * lighting.shadow_y_scale.w;
  let depth = 0.5 - dot(relative, lighting.shadow_z_scale.xyz) * lighting.shadow_z_scale.w;
  return vec4f(x, y, depth, 1.0);
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
  let seeded_index = index + u32(simulation.padding) * 1664525u;
  let random_a = hash(seeded_index);
  let random_b = hash(seeded_index + 11731u);
  let random_c = hash(seeded_index + 97127u);
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
