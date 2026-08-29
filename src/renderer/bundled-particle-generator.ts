import { BUILTIN_PARTICLE_NODE_TYPE, BUILTIN_PARTICLE_PLUGIN_ID } from "../core/bundled-particle";
import type { PluginManifest, PluginParameter, SceneGeneratorGraph } from "../core/plugins";
import { SCENE_GENERATOR_API_VERSION } from "../core/scene-generator";
import { sceneGeneratorDefinitionFromManifest } from "../core/scene-generator-registry";
import { sceneGeneratorAbiWgsl } from "./scene-generator-abi";

const COMPUTE_SHADER = "particle-compute.wgsl";
const RENDER_SHADER = "particle-render.wgsl";

export const bundledParticleParameters: PluginParameter[] = [
  {
    type: "choice",
    name: "renderMode",
    label: "Render mode",
    default: "billboard",
    choices: ["billboard", "streak", "mesh"],
  },
  {
    type: "choice",
    name: "meshPrimitive",
    label: "Mesh primitive",
    default: "cube",
    choices: ["cube"],
  },
  { type: "number", name: "count", label: "Count", default: 100_000, min: 1, max: 1_000_000 },
  { type: "number", name: "seed", label: "Seed", default: 13_337, min: 0, max: 16_777_215 },
  { type: "number", name: "lifetime", label: "Lifetime", default: 4, min: 0.05, max: 3_600 },
  {
    type: "choice",
    name: "emitterShape",
    label: "Emitter shape",
    default: "point",
    choices: ["point", "box", "sphere", "ring", "line"],
  },
  {
    type: "vector",
    name: "emitterPosition",
    label: "Emitter position",
    default: [0, 0, 0],
    min: -100_000,
    max: 100_000,
  },
  {
    type: "vector",
    name: "emitterSize",
    label: "Emitter size",
    default: [0, 0, 0],
    min: 0,
    max: 100_000,
  },
  { type: "number", name: "emitterSpread", label: "Emitter spread", default: 12, min: 0, max: 180 },
  {
    type: "vector",
    name: "velocity",
    label: "Velocity",
    default: [0, -0.26, 0],
    min: -10_000,
    max: 10_000,
  },
  {
    type: "vector",
    name: "gravity",
    label: "Gravity",
    default: [0, 0.08, 0],
    min: -10_000,
    max: 10_000,
  },
  { type: "number", name: "drag", label: "Drag", default: 0.04, min: 0, max: 10 },
  { type: "number", name: "turbulence", label: "Turbulence", default: 0.06, min: 0, max: 10 },
  {
    type: "number",
    name: "turbulenceScale",
    label: "Turbulence scale",
    default: 3,
    min: 0.01,
    max: 100,
  },
  {
    type: "vector",
    name: "startColor",
    label: "Start color",
    default: [1, 0.48, 0.12],
    min: 0,
    max: 16,
  },
  {
    type: "vector",
    name: "endColor",
    label: "End color",
    default: [0.12, 0.35, 1],
    min: 0,
    max: 16,
  },
  { type: "number", name: "startOpacity", label: "Start opacity", default: 0.9, min: 0, max: 1 },
  { type: "number", name: "endOpacity", label: "End opacity", default: 0, min: 0, max: 1 },
  { type: "number", name: "startSize", label: "Start size", default: 16, min: 0.01, max: 256 },
  { type: "number", name: "endSize", label: "End size", default: 2, min: 0.01, max: 256 },
  {
    type: "number",
    name: "startRotation",
    label: "Start rotation",
    default: 0,
    min: -36_000,
    max: 36_000,
  },
  {
    type: "number",
    name: "endRotation",
    label: "End rotation",
    default: 180,
    min: -36_000,
    max: 36_000,
  },
  { type: "number", name: "streakLength", label: "Streak length", default: 1, min: 0.01, max: 5 },
];

export const bundledParticleGraph: SceneGeneratorGraph = {
  api_version: 1,
  node_type: BUILTIN_PARTICLE_NODE_TYPE,
  capacity_parameter: "count",
  max_instances: 1_000_000,
  instance_stride: 48,
  render_parameter: "renderMode",
  compute_passes: [
    {
      id: "simulate",
      shader: COMPUTE_SHADER,
      entry_point: "compute_main",
      workgroup_size: [256, 1, 1],
      phase: "simulation",
    },
  ],
  render_variants: [
    renderVariant("billboard", 6, "none", "none"),
    renderVariant("streak", 6, "none", "none"),
    renderVariant("mesh", 36, "read_write", "back", "layer"),
  ],
};

function renderVariant(
  id: "billboard" | "streak" | "mesh",
  vertexCount: number,
  depth: "none" | "read_write",
  cull: "none" | "back",
  blend: "add" | "layer" = "layer",
): SceneGeneratorGraph["render_variants"][number] {
  return {
    id,
    shader: RENDER_SHADER,
    vertex_entry: `${id}_vertex`,
    fragment_entry: `${id}_fragment`,
    vertex_count: vertexCount,
    selector_value: id,
    blend,
    depth,
    cull,
    auxiliary: {
      shader: RENDER_SHADER,
      vertex_entry: `${id}_vertex`,
      fragment_entry: `${id}_auxiliary`,
    },
  };
}

const particleProjectionWgsl = /* wgsl */ `
fn rotate_xyz(value: vec3f, degrees: vec3f) -> vec3f {
  let angle = degrees * 0.01745329252;
  var result = value;
  result = vec3f(result.x, result.y * cos(angle.x) - result.z * sin(angle.x), result.y * sin(angle.x) + result.z * cos(angle.x));
  result = vec3f(result.x * cos(angle.y) + result.z * sin(angle.y), result.y, -result.x * sin(angle.y) + result.z * cos(angle.y));
  return vec3f(result.x * cos(angle.z) - result.y * sin(angle.z), result.x * sin(angle.z) + result.y * cos(angle.z), result.z);
}

fn inverse_rotate_xyz(value: vec3f, degrees: vec3f) -> vec3f {
  let angle = -degrees * 0.01745329252;
  var result = value;
  result = vec3f(result.x * cos(angle.z) - result.y * sin(angle.z), result.x * sin(angle.z) + result.y * cos(angle.z), result.z);
  result = vec3f(result.x * cos(angle.y) + result.z * sin(angle.y), result.y, -result.x * sin(angle.y) + result.z * cos(angle.y));
  return vec3f(result.x, result.y * cos(angle.x) - result.z * sin(angle.x), result.y * sin(angle.x) + result.z * cos(angle.x));
}

fn generator_world(local: vec3f) -> vec3f {
  let composition_size = aster_context.composition.xy;
  let local_pixels = vec3f(local.x, -local.y, local.z) * composition_size.y * 0.5;
  let scaled = local_pixels * aster_context.layer_scale.xyz * 0.01;
  return aster_context.layer_position_opacity.xyz + rotate_xyz(scaled, aster_context.layer_rotation.xyz);
}

fn generator_clip(local: vec3f) -> vec3f {
  let world = generator_world(local);
  let composition_size = aster_context.composition.xy;
  if aster_context.layer_rotation.w < 0.5 {
    return vec3f(
      world.x / composition_size.x * 2.0 - 1.0,
      1.0 - world.y / composition_size.y * 2.0,
      clamp(0.5 - world.z / max(composition_size.y * 2.0, 1.0), 0.001, 0.999),
    );
  }
  let view = inverse_rotate_xyz(world - aster_context.camera_position.xyz, aster_context.camera_rotation.xyz);
  let projection = aster_context.camera_projection;
  let perspective = select(
    projection.w / max(projection.w * 0.08, projection.w - view.z),
    composition_size.y / max(projection.z, 1.0),
    projection.x > 0.5,
  );
  return vec3f(
    view.x * perspective / composition_size.x * 2.0,
    -view.y * perspective / composition_size.y * 2.0,
    clamp(0.5 - view.z / max(projection.w * 2.0, 1.0), 0.001, 0.999),
  );
}
`;

export const particleGeneratorComputeShader = /* wgsl */ `
${sceneGeneratorAbiWgsl}
struct Particle { current: vec4f, previous: vec4f, appearance: vec4f }
@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read_write> aster_instances: array<Particle>;
@group(0) @binding(3) var<storage, read_write> aster_draw: AsterDrawIndirect;

${particleProjectionWgsl}

fn parameter(index: u32) -> vec4f { return aster_parameters.values[index]; }
fn hash(value: u32) -> f32 {
  var state = value * 747796405u + 2891336453u;
  state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  state = (state >> 22u) ^ state;
  return f32(state) / 4294967295.0;
}
fn random_unit(a: f32, b: f32) -> vec3f {
  let z = a * 2.0 - 1.0;
  let radius = sqrt(max(0.0, 1.0 - z * z));
  let angle = b * 6.28318530718;
  return vec3f(cos(angle) * radius, sin(angle) * radius, z);
}
fn emitter_origin(shape: u32, a: f32, b: f32, c: f32) -> vec3f {
  let size = parameter(7u).xyz;
  var local = vec3f(0.0);
  if shape == 1u { local = (vec3f(a, b, c) - vec3f(0.5)) * size; }
  else if shape == 2u { local = random_unit(a, b) * pow(c, 0.333333333) * size * 0.5; }
  else if shape == 3u {
    let angle = a * 6.28318530718;
    local = vec3f(cos(angle) * size.x, sin(angle) * size.y, (b - 0.5) * size.z) * 0.5;
  } else if shape == 4u {
    local = vec3f((a - 0.5) * size.x, (b - 0.5) * size.y, (c - 0.5) * size.z);
    local *= vec3f(1.0, select(0.0, 0.08, size.y > 0.0), select(0.0, 0.08, size.z > 0.0));
  }
  return parameter(6u).xyz + local;
}
fn launch_velocity(a: f32, b: f32) -> vec3f {
  let base = parameter(9u).xyz;
  let speed = length(base);
  if speed < 0.000001 { return vec3f(0.0); }
  let forward = normalize(base);
  var helper = vec3f(0.0, 0.0, 1.0);
  if abs(forward.z) > 0.999 { helper = vec3f(0.0, 1.0, 0.0); }
  let tangent = normalize(cross(helper, forward));
  let bitangent = cross(forward, tangent);
  let minimum_cosine = cos(clamp(parameter(8u).x * 0.01745329252, 0.0, 3.14159265359));
  let cosine = mix(1.0, minimum_cosine, a);
  let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
  let azimuth = b * 6.28318530718;
  return (tangent * cos(azimuth) * sine + bitangent * sin(azimuth) * sine + forward * cosine) * speed;
}
fn integrated_motion(origin: vec3f, velocity: vec3f, elapsed: f32, phase: vec3f) -> vec3f {
  let drag = parameter(11u).x;
  let gravity = parameter(10u).xyz;
  var position: vec3f;
  if drag < 0.0001 { position = origin + velocity * elapsed + gravity * (0.5 * elapsed * elapsed); }
  else {
    let decay = exp(-drag * elapsed);
    let velocity_integral = (1.0 - decay) / drag;
    position = origin + velocity * velocity_integral + gravity * (elapsed / drag - velocity_integral / drag);
  }
  let wave = sin(origin * parameter(13u).x + phase + vec3f(0.73, 0.91, 1.17) * elapsed);
  return position + wave * parameter(12u).x * min(elapsed, parameter(4u).x);
}

@compute @workgroup_size(256)
fn compute_main(@builtin(global_invocation_id) global_id: vec3u) {
  let index = global_id.x;
  if index >= aster_context.instance_count { return; }
  let seeded_index = index + (aster_context.instance_seed ^ u32(parameter(3u).x)) * 1664525u;
  let lifetime = max(parameter(4u).x, 0.05);
  let cycle_phase = hash(seeded_index);
  let phase_time = aster_context.local_time / lifetime + cycle_phase;
  let previous_phase_time = (aster_context.local_time - aster_context.frame_duration) / lifetime + cycle_phase;
  let age = fract(phase_time);
  let previous_age = fract(previous_phase_time);
  let cycle_number = floor(phase_time);
  let previous_cycle_number = floor(previous_phase_time);
  let cycle_seed = seeded_index + u32(max(cycle_number, 0.0)) * 1013904223u;
  let a = hash(cycle_seed + 17u);
  let b = hash(cycle_seed + 11731u);
  let c = hash(cycle_seed + 97127u);
  let d = hash(cycle_seed + 271003u);
  let origin = emitter_origin(u32(parameter(5u).x), a, b, c);
  let velocity = launch_velocity(c, d);
  let phase = vec3f(b, c, d) * 6.28318530718;
  let current = integrated_motion(origin, velocity, age * lifetime, phase);
  let raw_previous = integrated_motion(origin, velocity, previous_age * lifetime, phase);
  let continuous = select(0.0, 1.0, cycle_number == previous_cycle_number);
  let previous = mix(current, raw_previous, continuous);
  let size = mix(parameter(18u).x, parameter(19u).x, age);
  let rotation = mix(parameter(20u).x, parameter(21u).x, age) * 0.01745329252;
  let clip = generator_clip(current);
  let margin = size * 2.0 / max(aster_context.resolution.y, 1.0);
  if abs(clip.x) <= 1.0 + margin && abs(clip.y) <= 1.0 + margin && clip.z > 0.0 && clip.z < 1.0 {
    let visible = atomicAdd(&aster_draw.instance_count, 1u);
    aster_instances[visible].current = vec4f(current, size);
    aster_instances[visible].previous = vec4f(previous, continuous);
    aster_instances[visible].appearance = vec4f(age, cos(rotation), sin(rotation), 0.0);
  }
}
`;

export const particleGeneratorRenderShader = /* wgsl */ `
${sceneGeneratorAbiWgsl}
struct Particle { current: vec4f, previous: vec4f, appearance: vec4f }
@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read> aster_instances: array<Particle>;

${particleProjectionWgsl}

struct ParticleVertex {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
  @location(2) world_position: vec3f,
  @location(3) normal: vec3f,
  @location(4) motion: vec2f,
}
struct AuxiliaryOutput {
  @location(0) normal: vec4f,
  @location(1) object_id: u32,
  @location(2) material_id: u32,
  @location(3) world_position: vec4f,
  @location(4) motion_vector: vec2f,
}
fn life_color(age: f32) -> vec4f {
  return vec4f(mix(aster_parameters.values[14].xyz, aster_parameters.values[15].xyz, age), mix(aster_parameters.values[16].x, aster_parameters.values[17].x, age) * aster_context.layer_position_opacity.w);
}
fn corners(vertex: u32) -> vec2f {
  return array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0))[vertex];
}
fn write_auxiliary(input: ParticleVertex) -> AuxiliaryOutput {
  var output: AuxiliaryOutput;
  output.normal = vec4f(normalize(input.normal), 1.0);
  output.object_id = aster_context.ids.x;
  output.material_id = aster_context.ids.y;
  output.world_position = vec4f(input.world_position, 1.0);
  output.motion_vector = input.motion;
  return output;
}

@vertex fn billboard_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleVertex {
  let particle = aster_instances[instance];
  let unit = corners(vertex);
  let rotated = vec2f(unit.x * particle.appearance.y - unit.y * particle.appearance.z, unit.x * particle.appearance.z + unit.y * particle.appearance.y);
  let center = generator_clip(particle.current.xyz);
  let previous = generator_clip(particle.previous.xyz);
  let scale = (aster_context.layer_scale.x + aster_context.layer_scale.y) * 0.005;
  let offset = rotated * particle.current.w * scale * vec2f(2.0 / aster_context.resolution.x, 2.0 / aster_context.resolution.y);
  var output: ParticleVertex;
  output.position = vec4f(center.xy + offset, center.z, 1.0);
  output.color = life_color(particle.appearance.x);
  output.local = unit;
  output.world_position = generator_world(particle.current.xyz);
  output.normal = vec3f(0.0, 0.0, 1.0);
  output.motion = (center.xy - previous.xy) * vec2f(0.5, -0.5) * particle.previous.w;
  return output;
}
@fragment fn billboard_fragment(input: ParticleVertex) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.72, 1.0, length(input.local));
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
@fragment fn billboard_auxiliary(input: ParticleVertex) -> AuxiliaryOutput {
  if length(input.local) >= 1.0 { discard; }
  return write_auxiliary(input);
}

@vertex fn streak_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleVertex {
  let along = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0)[vertex];
  let side = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0)[vertex];
  let particle = aster_instances[instance];
  let center = generator_clip(particle.current.xyz);
  let previous = generator_clip(particle.previous.xyz);
  let motion = (center.xy - previous.xy) * particle.previous.w * aster_parameters.values[22].x;
  var direction = vec2f(1.0, 0.0);
  if length(motion) > 0.000001 { direction = normalize(motion); }
  let normal = vec2f(-direction.y, direction.x);
  let width = particle.current.w * (aster_context.layer_scale.x + aster_context.layer_scale.y) * 0.005 * 2.0 / aster_context.resolution.y;
  var output: ParticleVertex;
  output.position = vec4f(center.xy - motion * along + normal * side * width, center.z, 1.0);
  output.color = life_color(particle.appearance.x);
  output.local = vec2f(along * 2.0 - 1.0, side);
  output.world_position = generator_world(particle.current.xyz);
  output.normal = vec3f(0.0, 0.0, 1.0);
  output.motion = (center.xy - previous.xy) * vec2f(0.5, -0.5) * particle.previous.w;
  return output;
}
@fragment fn streak_fragment(input: ParticleVertex) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.72, 1.0, abs(input.local.y));
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
@fragment fn streak_auxiliary(input: ParticleVertex) -> AuxiliaryOutput {
  if abs(input.local.y) >= 1.0 { discard; }
  return write_auxiliary(input);
}

fn cube_position(vertex: u32) -> vec3f {
  let corner = corners(vertex % 6u);
  let face = vertex / 6u;
  if face == 0u { return vec3f(1.0, corner.y, -corner.x); }
  if face == 1u { return vec3f(-1.0, corner.y, corner.x); }
  if face == 2u { return vec3f(corner.x, 1.0, -corner.y); }
  if face == 3u { return vec3f(-corner.x, -1.0, -corner.y); }
  if face == 4u { return vec3f(corner.x, corner.y, 1.0); }
  return vec3f(-corner.x, corner.y, -1.0);
}
@vertex fn mesh_vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ParticleVertex {
  let particle = aster_instances[instance];
  let surface = cube_position(vertex);
  let local = vec3f(surface.x * particle.appearance.y - surface.y * particle.appearance.z, surface.x * particle.appearance.z + surface.y * particle.appearance.y, surface.z);
  let size_local = particle.current.w * 2.0 / max(aster_context.composition.y, 1.0);
  let clip = generator_clip(particle.current.xyz + local * size_local);
  let previous = generator_clip(particle.previous.xyz + local * size_local);
  var output: ParticleVertex;
  output.position = vec4f(clip, 1.0);
  output.color = life_color(particle.appearance.x);
  output.local = vec2f(0.0);
  output.world_position = generator_world(particle.current.xyz + local * size_local);
  output.normal = normalize(rotate_xyz(surface, aster_context.layer_rotation.xyz));
  output.motion = (clip.xy - previous.xy) * vec2f(0.5, -0.5) * particle.previous.w;
  return output;
}
@fragment fn mesh_fragment(input: ParticleVertex) -> @location(0) vec4f {
  let light = normalize(vec3f(0.35, -0.55, 0.76));
  let diffuse = 0.2 + 0.8 * max(dot(normalize(input.normal), light), 0.0);
  return vec4f(input.color.rgb * diffuse * input.color.a, input.color.a);
}
@fragment fn mesh_auxiliary(input: ParticleVertex) -> AuxiliaryOutput { return write_auxiliary(input); }
`;

export const bundledParticleManifest: PluginManifest = {
  plugin: {
    id: BUILTIN_PARTICLE_PLUGIN_ID,
    name: "Particles",
    version: "1.0.0",
    api_version: SCENE_GENERATOR_API_VERSION,
    shader: COMPUTE_SHADER,
    kind: "scene_generator",
  },
  capabilities: ["gpu_compute", "gpu_render"],
  parameters: bundledParticleParameters,
  scene_generator: bundledParticleGraph,
};

export const bundledParticleDefinition = sceneGeneratorDefinitionFromManifest(
  bundledParticleManifest,
  {
    [COMPUTE_SHADER]: particleGeneratorComputeShader,
    [RENDER_SHADER]: particleGeneratorRenderShader,
  },
);
