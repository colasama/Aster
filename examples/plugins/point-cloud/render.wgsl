struct AsterGeneratorContext {
  resolution: vec2f, composition_time: f32, local_time: f32,
  frame_duration: f32, reserved_time: f32, instance_count: u32, instance_seed: u32,
  layer_position_opacity: vec4f, layer_rotation: vec4f, layer_scale: vec4f,
  camera_position: vec4f, camera_rotation: vec4f, camera_projection: vec4f,
  composition: vec4f, ids: vec4u,
  camera_right: vec4f, camera_down: vec4f, camera_forward: vec4f,
}
struct AsterGeneratorParameters { values: array<vec4f, 128> }
struct PointRecord { position: vec4f }
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
}

@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read> aster_instances: array<PointRecord>;

@vertex
fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let point = aster_instances[instance].position;
  let center_pixels = aster_context.layer_position_opacity.xy
    + point.xy * point.w * aster_context.composition.y * 0.5;
  let center = vec2f(
    center_pixels.x / aster_context.composition.x * 2.0 - 1.0,
    1.0 - center_pixels.y / aster_context.composition.y * 2.0,
  );
  let local = corners[vertex];
  let size = aster_parameters.values[2].x;
  var output: VertexOutput;
  output.position = vec4f(
    center + local * size * vec2f(2.0 / aster_context.resolution.x, 2.0 / aster_context.resolution.y),
    clamp(0.5 - point.z * 0.2, 0.001, 0.999),
    1.0,
  );
  output.local = local;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.65, 1.0, length(input.local));
  let alpha = coverage * aster_context.layer_position_opacity.w;
  return vec4f(aster_parameters.values[3].xyz * alpha, alpha);
}
