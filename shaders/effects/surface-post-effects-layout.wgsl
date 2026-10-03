
struct Settings {
  viewport: vec2f,
  mode: u32,
  selected_id: u32,
  motion: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(0) @binding(0) var hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var object_ids: texture_2d<u32>;
@group(0) @binding(3) var motion_vectors: texture_2d<f32>;
@group(0) @binding(4) var<uniform> settings: Settings;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

