
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
