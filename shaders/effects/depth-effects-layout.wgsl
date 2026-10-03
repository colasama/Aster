
struct Settings {
  viewport: vec4f,
  fog: vec4f,
  lens: vec4f,
  camera: vec4f,
  optics: vec4f,
  blur: vec4f,
  iris: vec4f,
  highlights: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(0) @binding(0) var hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var world_position: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;
@group(0) @binding(4) var transparent_world_position: texture_2d<f32>;
@group(0) @binding(5) var peeled_world_position: texture_2d<f32>;
@group(0) @binding(6) var front_layer_color: texture_2d<f32>;
@group(0) @binding(7) var peeled_layer_color: texture_2d<f32>;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

