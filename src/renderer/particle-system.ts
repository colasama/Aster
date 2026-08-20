import type { ParticleSettings } from "../core/types";

export const PARTICLE_UNIFORM_FLOATS = 36;
export const PARTICLE_STORAGE_STRIDE_BYTES = 48;
export const PARTICLE_WORKGROUP_SIZE = 256;
export const PARTICLE_DETERMINISM = {
  state: "absolute-time-per-slot",
  visibilityOrder: "gpu-compaction-unspecified",
} as const;

const EMITTER_SHAPE_CODE: Record<ParticleSettings["emitterShape"], number> = {
  point: 0,
  box: 1,
  sphere: 2,
  ring: 3,
  line: 4,
};

export function buildParticleSimulationUniforms(
  settings: ParticleSettings,
  time: number,
  aspectRatio: number,
  frameDuration: number,
  effectiveCount: number,
): Float32Array {
  return new Float32Array([
    time,
    aspectRatio,
    effectiveCount,
    settings.seed,
    settings.lifetime,
    frameDuration,
    settings.drag,
    settings.turbulence,
    ...settings.emitterPosition,
    EMITTER_SHAPE_CODE[settings.emitterShape],
    ...settings.emitterSize,
    (settings.emitterSpread * Math.PI) / 180,
    ...settings.velocity,
    settings.turbulenceScale,
    ...settings.gravity,
    settings.streakLength,
    settings.startSize,
    settings.endSize,
    settings.startRotation,
    settings.endRotation,
    ...settings.startColor,
    settings.startOpacity,
    ...settings.endColor,
    settings.endOpacity,
  ]);
}

export const particleComputeShader = /* wgsl */ `
struct Simulation {
  header: vec4f,
  lifecycle: vec4f,
  emitter_position_shape: vec4f,
  emitter_size_spread: vec4f,
  velocity_scale: vec4f,
  gravity_streak: vec4f,
  appearance: vec4f,
  start_color: vec4f,
  end_color: vec4f,
}

struct DrawIndirect {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}

struct Particle {
  current: vec4f,
  previous: vec4f,
  appearance: vec4f,
}

@group(0) @binding(0) var<uniform> simulation: Simulation;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> particle_draw: DrawIndirect;

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

fn emitter_origin(shape: u32, a: f32, b: f32, c: f32, d: f32) -> vec3f {
  let size = simulation.emitter_size_spread.xyz;
  var local = vec3f(0.0);
  if shape == 1u {
    local = (vec3f(a, b, c) - vec3f(0.5)) * size;
  } else if shape == 2u {
    local = random_unit(a, b) * pow(c, 0.333333333) * size * 0.5;
  } else if shape == 3u {
    let angle = a * 6.28318530718;
    local = vec3f(cos(angle) * size.x, sin(angle) * size.y, (b - 0.5) * size.z) * 0.5;
  } else if shape == 4u {
    local = vec3f((a - 0.5) * size.x, (b - 0.5) * size.y, (c - 0.5) * size.z);
    local *= vec3f(1.0, select(0.0, 0.08, size.y > 0.0), select(0.0, 0.08, size.z > 0.0));
  }
  return simulation.emitter_position_shape.xyz + local;
}

fn launch_velocity(a: f32, b: f32) -> vec3f {
  let base = simulation.velocity_scale.xyz;
  let speed = length(base);
  if speed < 0.000001 { return vec3f(0.0); }
  let forward = normalize(base);
  var helper = vec3f(0.0, 0.0, 1.0);
  if abs(forward.z) > 0.999 { helper = vec3f(0.0, 1.0, 0.0); }
  let tangent = normalize(cross(helper, forward));
  let bitangent = cross(forward, tangent);
  let minimum_cosine = cos(clamp(simulation.emitter_size_spread.w, 0.0, 3.14159265359));
  let cosine = mix(1.0, minimum_cosine, a);
  let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
  let azimuth = b * 6.28318530718;
  let direction = tangent * (cos(azimuth) * sine)
    + bitangent * (sin(azimuth) * sine) + forward * cosine;
  return direction * speed;
}

fn integrated_motion(origin: vec3f, velocity: vec3f, elapsed: f32, phase: vec3f) -> vec3f {
  let drag = simulation.lifecycle.z;
  let gravity = simulation.gravity_streak.xyz;
  var position: vec3f;
  if drag < 0.0001 {
    position = origin + velocity * elapsed + gravity * (0.5 * elapsed * elapsed);
  } else {
    let decay = exp(-drag * elapsed);
    let velocity_integral = (1.0 - decay) / drag;
    let gravity_integral = elapsed / drag - velocity_integral / drag;
    position = origin + velocity * velocity_integral + gravity * gravity_integral;
  }
  let scale = simulation.velocity_scale.w;
  let turbulence = simulation.lifecycle.w;
  let wave = sin(origin * scale + phase + vec3f(0.73, 0.91, 1.17) * elapsed);
  return position + wave * turbulence * min(elapsed, simulation.lifecycle.x);
}

@compute @workgroup_size(256)
fn compute_main(@builtin(global_invocation_id) global_id: vec3u) {
  let index = global_id.x;
  if f32(index) >= simulation.header.z { return; }
  let seeded_index = index + u32(simulation.header.w) * 1664525u;
  let cycle_phase = hash(seeded_index);
  let lifetime = max(simulation.lifecycle.x, 0.05);
  let phase_time = simulation.header.x / lifetime + cycle_phase;
  let previous_phase_time =
    (simulation.header.x - simulation.lifecycle.y) / lifetime + cycle_phase;
  let age = fract(phase_time);
  let previous_age = fract(previous_phase_time);
  let cycle_number = floor(phase_time);
  let previous_cycle_number = floor(previous_phase_time);
  let cycle = u32(max(cycle_number, 0.0));
  let cycle_seed = seeded_index + cycle * 1013904223u;
  let random_a = hash(cycle_seed + 17u);
  let random_b = hash(cycle_seed + 11731u);
  let random_c = hash(cycle_seed + 97127u);
  let random_d = hash(cycle_seed + 271003u);
  let elapsed = age * lifetime;
  let previous_elapsed = previous_age * lifetime;
  let origin = emitter_origin(
    u32(simulation.emitter_position_shape.w), random_a, random_b, random_c, random_d,
  );
  let velocity = launch_velocity(random_c, random_d);
  let turbulence_phase = vec3f(random_b, random_c, random_d) * 6.28318530718;
  let world = integrated_motion(origin, velocity, elapsed, turbulence_phase);
  let raw_previous_world = integrated_motion(origin, velocity, previous_elapsed, turbulence_phase);
  let position = vec3f(world.x / max(simulation.header.y, 1.0), world.y, world.z);
  // A previous sample belongs to this trajectory only when it is in the same
  // lifetime cycle. This stays correct even when one frame spans many cycles.
  let continuous = select(0.0, 1.0, cycle_number == previous_cycle_number);
  let raw_previous_position = vec3f(
    raw_previous_world.x / max(simulation.header.y, 1.0),
    raw_previous_world.y,
    raw_previous_world.z,
  );
  let previous_position = mix(position, raw_previous_position, continuous);
  let size = mix(simulation.appearance.x, simulation.appearance.y, age);
  let rotation = mix(simulation.appearance.z, simulation.appearance.w, age) * 0.01745329252;
  let margin = size / 900.0 + length(position.xy - previous_position.xy)
    * simulation.gravity_streak.w * continuous;
  if abs(position.x) <= 1.0 + margin && abs(position.y) <= 1.0 + margin {
    // Slot state is deterministic; atomic visibility compaction order is intentionally unspecified.
    let visible_index = atomicAdd(&particle_draw.instance_count, 1u);
    particles[visible_index].current = vec4f(position, size);
    particles[visible_index].previous = vec4f(previous_position, continuous);
    particles[visible_index].appearance = vec4f(age, cos(rotation), sin(rotation), 0.0);
  }
}
`;

const PARTICLE_RENDER_TYPES = /* wgsl */ `
struct Simulation {
  header: vec4f, lifecycle: vec4f,
  emitter_position_shape: vec4f, emitter_size_spread: vec4f,
  velocity_scale: vec4f, gravity_streak: vec4f, appearance: vec4f,
  start_color: vec4f, end_color: vec4f,
}
struct Particle { current: vec4f, previous: vec4f, appearance: vec4f }
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> simulation: Simulation;

fn life_color(age: f32) -> vec4f {
  return mix(simulation.start_color, simulation.end_color, age);
}
`;

export const particleBillboardRenderShader = /* wgsl */ `
${PARTICLE_RENDER_TYPES}

@vertex fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let particle = particles[instance];
  let unit = corners[vertex];
  let rotated = vec2f(
    unit.x * particle.appearance.y - unit.y * particle.appearance.z,
    unit.x * particle.appearance.z + unit.y * particle.appearance.y,
  );
  let size = particle.current.w / 900.0;
  var output: VertexOutput;
  output.position = vec4f(
    particle.current.xy + rotated * size,
    clamp(0.5 - particle.current.z * 0.1, 0.001, 0.999),
    1.0,
  );
  output.color = life_color(particle.appearance.x);
  output.local = unit;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.72, 1.0, length(input.local));
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
`;

export const particleStreakRenderShader = /* wgsl */ `
${PARTICLE_RENDER_TYPES}

@vertex fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  let along = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  let side = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let particle = particles[instance];
  let motion = (particle.current.xy - particle.previous.xy)
    * particle.previous.w * simulation.gravity_streak.w;
  var direction = vec2f(1.0, 0.0);
  if length(motion) > 0.000001 { direction = normalize(motion); }
  let normal = vec2f(-direction.y, direction.x);
  let half_width = particle.current.w / 900.0;
  let center = particle.current.xy - motion * along[vertex];
  var output: VertexOutput;
  output.position = vec4f(
    center + normal * side[vertex] * half_width,
    clamp(0.5 - particle.current.z * 0.1, 0.001, 0.999),
    1.0,
  );
  output.color = life_color(particle.appearance.x);
  output.local = vec2f(along[vertex] * 2.0 - 1.0, side[vertex]);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let coverage = 1.0 - smoothstep(0.72, 1.0, abs(input.local.y));
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
`;
