

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
  if index == 0u { atomicStore(&aster_draw.instance_count, aster_context.instance_count); }
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
  let visible = abs(clip.x) <= 1.0 + margin && abs(clip.y) <= 1.0 + margin && clip.z > 0.0 && clip.z < 1.0;
  // Stable source indices keep blending and transparent depth writes independent of invocation order.
  // Every slot is overwritten, including culled particles, so seeking cannot expose stale geometry.
  aster_instances[index].current = vec4f(current, size);
  aster_instances[index].previous = vec4f(previous, continuous);
  aster_instances[index].appearance = vec4f(age, cos(rotation), sin(rotation), select(0.0, 1.0, visible));
}
