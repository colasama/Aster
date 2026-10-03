
struct MaterialTextureSettings {
  normal_environment: vec4f,
}

@group(1) @binding(0) var normal_texture: texture_2d<f32>;
@group(1) @binding(1) var environment_texture: texture_2d<f32>;
@group(1) @binding(2) var normal_sampler: sampler;
@group(1) @binding(3) var environment_sampler: sampler;
@group(1) @binding(4) var<uniform> material_textures: MaterialTextureSettings;

fn environment_uv(direction: vec3f, rotation: f32) -> vec2f {
  let normalized = safe_normalize3(direction, vec3f(0.0, 0.0, 1.0));
  let longitude = atan2(normalized.z, normalized.x) / 6.28318530718 + 0.5 + rotation;
  let latitude = acos(clamp(normalized.y, -1.0, 1.0)) / 3.14159265359;
  return vec2f(fract(longitude), clamp(latitude, 0.0, 1.0));
}

fn sample_environment_cone(direction: vec3f, spread: f32, rotation: f32) -> vec3f {
  let center = safe_normalize3(direction, vec3f(0.0, 0.0, 1.0));
  let reference = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(center.y) > 0.9);
  let tangent = safe_normalize3(cross(reference, center), vec3f(1.0, 0.0, 0.0));
  let bitangent = safe_normalize3(cross(center, tangent), vec3f(0.0, 1.0, 0.0));
  let radius = clamp(spread, 0.0, 1.0) * 0.62;
  var integrated = textureSampleLevel(
    environment_texture, environment_sampler, environment_uv(center, rotation), 0.0
  ).rgb * 0.4;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center + tangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center - tangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center + bitangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center - bitangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  return integrated;
}
