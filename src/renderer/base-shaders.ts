export const shapeShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: f32,
  @location(3) normal: vec3f,
  @location(4) material: vec4f,
  @location(5) world_position: vec3f,
  @location(6) shape_style_color: vec4f,
  @location(7) shape_style_parameters: vec4f,
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
  @location(7) shape_style_color: vec4f,
  @location(8) shape_style_parameters: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.shape = shape;
  output.normal = normal;
  output.material = material;
  output.world_position = world_position;
  output.shape_style_color = shape_style_color;
  output.shape_style_parameters = shape_style_parameters;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var alpha = input.color.a;
  if input.shape_style_parameters.z > 0.5 {
    let centered = input.uv - vec2f(0.5);
    let ellipse_distance = (length(centered * 2.0) - 1.0) * 0.5;
    let radius = input.shape_style_parameters.y;
    let rounded = abs(centered) - vec2f(0.5 - radius);
    let rectangle_distance = length(max(rounded, vec2f(0.0)))
      + min(max(rounded.x, rounded.y), 0.0) - radius;
    var shape_distance = select(
      rectangle_distance,
      ellipse_distance,
      input.shape_style_parameters.z > 1.5,
    );
    if input.shape_style_parameters.z > 2.5 {
      let segment_start = vec2f(-0.5, 0.0);
      let segment = vec2f(1.0, 0.0);
      let relative = centered - segment_start;
      let along = clamp(dot(relative, segment) / dot(segment, segment), 0.0, 1.0);
      shape_distance = length(relative - segment * along)
        - max(input.shape_style_parameters.x * 0.5, 0.003);
    }
    let antialias = 0.006;
    let coverage = 1.0 - smoothstep(0.0, antialias, shape_distance);
    let stroke_width = input.shape_style_parameters.x;
    var stroke = select(
      0.0,
      1.0 - smoothstep(stroke_width, stroke_width + antialias, abs(shape_distance)),
      stroke_width > 0.0,
    ) * input.shape_style_color.a;
    if input.shape_style_parameters.z > 2.5 { stroke = 1.0; }
    let shape_color = mix(input.color.rgb, input.shape_style_color.rgb, stroke);
    alpha *= coverage;
    return vec4f(shape_color * alpha, alpha);
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
  header: vec4f,
  motion: vec4f,
  appearance: vec4f,
  start_color: vec4f,
  end_color: vec4f,
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
  if f32(index) >= simulation.header.z { return; }
  let seeded_index = index + u32(simulation.header.w) * 1664525u;
  let random_a = hash(seeded_index);
  let random_b = hash(seeded_index + 11731u);
  let random_c = hash(seeded_index + 97127u);
  let lifetime = max(simulation.motion.x, 0.05);
  let age = fract(simulation.header.x / lifetime + random_a);
  let elapsed = age * lifetime;
  let angle = random_b * 6.283185;
  let spawn_radius = sqrt(random_c) * 0.12;
  let origin = vec2f(cos(angle), sin(angle)) * spawn_radius;
  let velocity_angle = angle + (random_a - 0.5) * 1.2;
  let velocity = vec2f(cos(velocity_angle), sin(velocity_angle)) * simulation.motion.y;
  let x = (origin.x + velocity.x * elapsed) / max(simulation.header.y, 1.0);
  let y = origin.y + velocity.y * elapsed + 0.5 * simulation.motion.z * elapsed * elapsed;
  let size = mix(simulation.motion.w, simulation.appearance.x, age);
  particles[index] = vec4f(x, y, size, age);
}
`;

export const particleRenderShader = /* wgsl */ `
struct Simulation {
  header: vec4f,
  motion: vec4f,
  appearance: vec4f,
  start_color: vec4f,
  end_color: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@group(0) @binding(0) var<storage, read> particles: array<vec4f>;
@group(0) @binding(1) var<uniform> simulation: Simulation;

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
  output.color = mix(simulation.start_color, simulation.end_color, particle.w);
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color.rgb * input.color.a, input.color.a);
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
