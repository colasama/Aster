
struct AsterGeneratorContext {
  resolution: vec2f,
  composition_time: f32,
  local_time: f32,
  frame_duration: f32,
  reserved_time: f32,
  instance_count: u32,
  instance_seed: u32,
  layer_position_opacity: vec4f,
  layer_rotation: vec4f,
  layer_scale: vec4f,
  camera_position: vec4f,
  camera_rotation: vec4f,
  camera_projection: vec4f,
  composition: vec4f,
  ids: vec4u,
  camera_right: vec4f,
  camera_down: vec4f,
  camera_forward: vec4f,
}

struct AsterGeneratorParameters {
  values: array<vec4f, 128>,
}

struct AsterDrawIndirect {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}
