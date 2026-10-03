

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
fn invisible_particle_vertex() -> ParticleVertex {
  var output: ParticleVertex;
  output.position = vec4f(2.0, 2.0, 2.0, 1.0);
  return output;
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
  if particle.appearance.w < 0.5 { return invisible_particle_vertex(); }
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
  let particle = aster_instances[instance];
  if particle.appearance.w < 0.5 { return invisible_particle_vertex(); }
  let along = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0)[vertex];
  let side = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0)[vertex];
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
  if particle.appearance.w < 0.5 { return invisible_particle_vertex(); }
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
