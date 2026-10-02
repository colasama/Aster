struct AsterGeneratorContext {
  resolution: vec2f, composition_time: f32, local_time: f32,
  frame_duration: f32, reserved_time: f32, instance_count: u32, instance_seed: u32,
  layer_position_opacity: vec4f, layer_rotation: vec4f, layer_scale: vec4f,
  camera_position: vec4f, camera_rotation: vec4f, camera_projection: vec4f,
  composition: vec4f, ids: vec4u,
  camera_right: vec4f, camera_down: vec4f, camera_forward: vec4f,
}
struct AsterGeneratorParameters { values: array<vec4f, 128> }
struct Element {
  base: vec2f,
  axis: vec2f,
  size: vec4f,
  color: vec4f,
  shape: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  // Element space in layer pixels: x across the element, y along its growth axis.
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) size: vec4f,
  @location(2) @interpolate(flat) color: vec4f,
  @location(3) @interpolate(flat) shape: vec4f,
}

@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read> aster_instances: array<Element>;

const KIND_BAR = 0u;
const KIND_MIRROR = 1u;
const KIND_SEGMENT = 2u;
const KIND_DOTS = 3u;
const FAR_AWAY = 1000000.0;

fn parameter(index: u32) -> f32 { return aster_parameters.values[index].x; }

fn rotate_xyz(value: vec3f, degrees: vec3f) -> vec3f {
  let angle = degrees * 0.01745329252;
  var result = value;
  result = vec3f(result.x, result.y * cos(angle.x) - result.z * sin(angle.x), result.y * sin(angle.x) + result.z * cos(angle.x));
  result = vec3f(result.x * cos(angle.y) + result.z * sin(angle.y), result.y, -result.x * sin(angle.y) + result.z * cos(angle.y));
  return vec3f(result.x * cos(angle.z) - result.y * sin(angle.z), result.x * sin(angle.z) + result.y * cos(angle.z), result.z);
}

// Layer pixels -> clip space through the layer transform and, for 3D layers, the active camera.
fn layer_clip(local: vec2f) -> vec3f {
  let scaled = vec3f(local, 0.0) * aster_context.layer_scale.xyz * 0.01;
  let world = aster_context.layer_position_opacity.xyz + rotate_xyz(scaled, aster_context.layer_rotation.xyz);
  let composition_size = aster_context.composition.xy;
  if aster_context.layer_rotation.w < 0.5 {
    return vec3f(
      world.x / composition_size.x * 2.0 - 1.0,
      1.0 - world.y / composition_size.y * 2.0,
      clamp(0.5 - world.z / max(composition_size.y * 2.0, 1.0), 0.001, 0.999),
    );
  }
  let relative = world - aster_context.camera_position.xyz;
  let view = vec3f(
    dot(relative, aster_context.camera_right.xyz),
    dot(relative, aster_context.camera_down.xyz),
    dot(relative, aster_context.camera_forward.xyz),
  );
  let projection = aster_context.camera_projection;
  let perspective = select(
    projection.w / max(view.z, 0.000001),
    composition_size.y / max(projection.z, 1.0),
    projection.x > 0.5,
  );
  let near = 0.1;
  let far = 10000000.0;
  let perspective_depth = far / (far - near) - (far * near) / ((far - near) * max(view.z, 0.000001));
  let orthographic_depth = (view.z - near) / (far - near);
  return vec3f(
    view.x * perspective / composition_size.x * 2.0,
    -view.y * perspective / composition_size.y * 2.0,
    clamp(select(perspective_depth, orthographic_depth, projection.x > 0.5), 0.001, 0.999),
  );
}

@vertex
fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let element = aster_instances[instance];
  let kind = u32(element.shape.x + 0.5);
  let pad = element.shape.w + 2.0;
  var along_min = -pad;
  var along_max = element.size.y + parameter(22) + pad;
  if kind == KIND_MIRROR { along_min = -along_max; }
  if kind == KIND_SEGMENT {
    along_min = -element.size.x - pad;
    along_max = element.size.y + element.size.x + pad;
  }
  let corner = corners[vertex];
  let across = corner.x * (element.size.x + pad);
  let along = mix(along_min, along_max, corner.y);
  let perpendicular = vec2f(-element.axis.y, element.axis.x);
  let clip = layer_clip(element.base + element.axis * along + perpendicular * across);
  var output: VertexOutput;
  output.position = vec4f(clip, 1.0);
  output.local = vec2f(across, along);
  output.size = element.size;
  output.color = element.color;
  output.shape = element.shape;
  return output;
}

fn rounded_box(point: vec2f, half_size: vec2f, roundness: f32) -> f32 {
  let radius = roundness * min(half_size.x, half_size.y);
  let q = abs(point) - half_size + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// Distance to an axis-aligned span [start, end] along y with the element's half width.
fn span(point: vec2f, start: f32, end: f32, half_width: f32, roundness: f32) -> f32 {
  if end - start < 0.01 { return FAR_AWAY; }
  let half_size = vec2f(half_width, (end - start) * 0.5);
  return rounded_box(point - vec2f(0.0, (start + end) * 0.5), half_size, roundness);
}

fn coverage(distance: f32, filter_width: f32) -> f32 {
  return clamp(0.5 - distance / filter_width, 0.0, 1.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  // Derivatives stay in uniform control flow, ahead of every per-element branch.
  let filter_width = max(length(fwidth(input.local)), 0.0001);
  let kind = u32(input.shape.x + 0.5);
  let half_width = input.size.x;
  let track = input.size.y;
  let level = input.size.z;
  let peak = input.size.w;
  let roundness = input.shape.z;
  let glow_radius = input.shape.w;
  let cap = parameter(22);
  var point = input.local;
  var fill = FAR_AWAY;
  var track_distance = FAR_AWAY;
  var cap_distance = FAR_AWAY;

  if kind == KIND_SEGMENT {
    let closest = vec2f(0.0, clamp(point.y, 0.0, track));
    fill = length(point - closest) - half_width;
  } else if kind == KIND_DOTS {
    let rows = max(input.shape.y, 1.0);
    let cell = track / rows;
    let row = clamp(floor(point.y / cell), 0.0, rows - 1.0);
    let cell_point = point - vec2f(0.0, (row + 0.5) * cell);
    let dot = rounded_box(cell_point, vec2f(half_width, cell * 0.38), roundness);
    let lit = (row + 0.5) * cell <= level;
    let capped = abs((row + 0.5) * cell - peak) < cell * 0.5 && !lit;
    fill = select(FAR_AWAY, dot, lit);
    cap_distance = select(FAR_AWAY, dot, capped);
    track_distance = dot;
  } else {
    if kind == KIND_MIRROR { point.y = abs(point.y); }
    fill = span(point, 0.0, level, half_width, roundness);
    track_distance = span(point, 0.0, track, half_width, roundness);
    cap_distance = span(point, peak + 1.0, peak + 1.0 + cap, half_width, roundness * 0.5);
  }

  let body = coverage(fill, filter_width);
  let caps = coverage(cap_distance, filter_width) * parameter(21);
  let core = max(body, caps);
  var glow = 0.0;
  if glow_radius > 0.0 && level > 0.5 {
    let glow_source = select(fill, span(point, 0.0, level, half_width, roundness), kind == KIND_DOTS);
    let falloff = 1.0 - clamp(max(glow_source, 0.0) / glow_radius, 0.0, 1.0);
    glow = parameter(20) * falloff * falloff * 0.6;
  }
  let ghost = coverage(track_distance, filter_width) * parameter(23);
  let opacity = input.color.a * aster_context.layer_position_opacity.w;
  let alpha = clamp(core + (ghost + glow) * (1.0 - core), 0.0, 1.0) * opacity;
  if alpha <= 0.0005 { discard; }
  let light = (core + glow * (1.0 - core) + ghost * 0.6 * (1.0 - core)) * opacity;
  return vec4f(input.color.rgb * light, alpha);
}
