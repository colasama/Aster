
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
  @location(8) gradient_style_color: vec4f,
  @location(9) gradient_style_parameters: vec4f,
  @location(10) tangent: vec4f,
}

struct AdditionalLight {
  direction_intensity: vec4f,
  color_padding: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
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
  camera_position: vec4f,
  additional: array<AdditionalLight, 