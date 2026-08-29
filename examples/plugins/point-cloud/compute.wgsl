struct AsterGeneratorContext {
  resolution: vec2f, composition_time: f32, local_time: f32,
  frame_duration: f32, reserved_time: f32, instance_count: u32, instance_seed: u32,
  layer_position_opacity: vec4f, layer_rotation: vec4f, layer_scale: vec4f,
  camera_position: vec4f, camera_rotation: vec4f, camera_projection: vec4f,
  composition: vec4f, ids: vec4u,
}
struct AsterGeneratorParameters { values: array<vec4f, 128> }
struct AsterDrawIndirect {
  vertex_count: u32, instance_count: atomic<u32>, first_vertex: u32, first_instance: u32,
}
struct PointRecord { position: vec4f }

@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read_write> aster_instances: array<PointRecord>;
@group(0) @binding(3) var<storage, read_write> aster_draw: AsterDrawIndirect;

fn hash(value: u32) -> f32 {
  var state = value * 747796405u + 2891336453u;
  state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  state = (state >> 22u) ^ state;
  return f32(state) / 4294967295.0;
}

@compute @workgroup_size(256)
fn compute_main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= aster_context.instance_count { return; }
  let a = hash(id.x * 3u + 1u);
  let b = hash(id.x * 3u + 2u);
  let z = a * 2.0 - 1.0;
  let ring = sqrt(max(0.0, 1.0 - z * z));
  let angle = b * 6.28318530718 + aster_context.local_time * 0.2;
  let radius = aster_parameters.values[1].x;
  let output_index = atomicAdd(&aster_draw.instance_count, 1u);
  aster_instances[output_index].position = vec4f(cos(angle) * ring, sin(angle) * ring, z, radius);
}
