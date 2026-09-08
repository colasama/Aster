/** Surface-data, two-layer depth-peel, and aggregate transparency shader. */
export const auxiliarySurfaceShader = /* wgsl */ `
struct SurfaceOutput {
  @location(0) normal: vec4f,
  @location(1) object_id: u32,
  @location(2) material_id: u32,
  @location(3) world_position: vec4f,
  @location(4) motion_vector: vec2f,
}
struct PeeledOutput {
  @location(0) world_position: vec4f,
  @location(1) color: vec4f,
}
struct SurfaceVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) normal: vec3f,
  @location(3) world_position: vec3f,
  @location(4) shape_parameters: vec4f,
  @location(5) @interpolate(flat) object_id: u32,
  @location(6) @interpolate(flat) material_id: u32,
  @location(7) motion_vector: vec2f,
}

@vertex fn surface_vertex(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(4) normal: vec3f,
  @location(6) world_position: vec3f,
  @location(8) shape_parameters: vec4f,
  @location(12) object_id: u32,
  @location(13) material_id: u32,
  @location(14) motion_vector: vec2f,
) -> SurfaceVertex {
  var output: SurfaceVertex;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.normal = normal;
  output.world_position = world_position;
  output.shape_parameters = shape_parameters;
  output.object_id = object_id;
  output.material_id = material_id;
  output.motion_vector = motion_vector;
  return output;
}

fn write_surface(input: SurfaceVertex, coverage: f32) -> SurfaceOutput {
  var output: SurfaceOutput;
  output.normal = vec4f(normalize(input.normal), 1.0);
  output.object_id = input.object_id;
  output.material_id = input.material_id;
  output.world_position = vec4f(input.world_position, clamp(coverage, 0.0, 1.0));
  output.motion_vector = input.motion_vector;
  return output;
}

fn shape_coverage(input: SurfaceVertex) -> f32 {
  if (input.color.a <= 0.00001) { return 0.0; }
  let kind = input.shape_parameters.z;
  let centered = input.uv - vec2f(0.5);
  if (kind > 1.5 && kind < 2.5) {
    return select(0.0, 1.0, length(centered * 2.0) <= 1.0);
  }
  if (kind > 0.5 && kind < 1.5) {
    let radius = input.shape_parameters.y;
    let rounded = abs(centered) - vec2f(0.5 - radius);
    let distance = length(max(rounded, vec2f(0.0))) + min(max(rounded.x, rounded.y), 0.0) - radius;
    return select(0.0, 1.0, distance <= 0.0);
  }
  if (kind > 2.5 && kind < 3.5) {
    let line_radius = max(input.shape_parameters.x * 0.5, 0.003);
    return select(0.0, 1.0, abs(centered.y) <= line_radius && abs(centered.x) <= 0.5);
  }
  return 1.0;
}

fn premultiplied_color(rgb: vec3f, coverage: f32) -> vec4f {
  let alpha = clamp(coverage, 0.0, 1.0);
  return vec4f(rgb * alpha, alpha);
}

@fragment fn surface_fragment(input: SurfaceVertex) -> SurfaceOutput {
  let coverage = shape_coverage(input) * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return write_surface(input, coverage);
}

@group(0) @binding(0) var media_texture: texture_2d<f32>;
@group(0) @binding(1) var media_sampler: sampler;
@group(1) @binding(0) var front_depth: texture_depth_2d;

@fragment fn media_fragment(input: SurfaceVertex) -> SurfaceOutput {
  let coverage = textureSample(media_texture, media_sampler, input.uv).a * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return write_surface(input, coverage);
}

@fragment fn front_color_surface_fragment(input: SurfaceVertex) -> @location(0) vec4f {
  let coverage = shape_coverage(input) * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return premultiplied_color(input.color.rgb, coverage);
}

@fragment fn front_color_media_fragment(input: SurfaceVertex) -> @location(0) vec4f {
  let sampled = textureSample(media_texture, media_sampler, input.uv);
  let coverage = sampled.a * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return premultiplied_color(sampled.rgb * input.color.rgb, coverage);
}

fn weighted_world_position(input: SurfaceVertex, coverage: f32) -> vec4f {
  let bounded_coverage = clamp(coverage, 0.0, 1.0);
  return vec4f(input.world_position * bounded_coverage, bounded_coverage);
}

fn peeled_output(input: SurfaceVertex, color: vec4f) -> PeeledOutput {
  let dimensions = vec2i(textureDimensions(front_depth));
  let pixel = clamp(vec2i(input.position.xy), vec2i(0), dimensions - vec2i(1));
  let nearest_depth = textureLoad(front_depth, pixel, 0);
  if (input.position.z <= nearest_depth + 0.000001) { discard; }
  var output: PeeledOutput;
  output.world_position = vec4f(input.world_position, color.a);
  output.color = color;
  return output;
}

@fragment fn peeled_surface_fragment(input: SurfaceVertex) -> PeeledOutput {
  let coverage = shape_coverage(input) * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return peeled_output(input, premultiplied_color(input.color.rgb, coverage));
}

@fragment fn peeled_media_fragment(input: SurfaceVertex) -> PeeledOutput {
  let sampled = textureSample(media_texture, media_sampler, input.uv);
  let coverage = sampled.a * input.color.a;
  if (coverage <= 0.00001) { discard; }
  return peeled_output(input, premultiplied_color(sampled.rgb * input.color.rgb, coverage));
}

@fragment fn transparent_surface_fragment(input: SurfaceVertex) -> @location(0) vec4f {
  return weighted_world_position(input, shape_coverage(input) * input.color.a);
}

@fragment fn transparent_media_fragment(input: SurfaceVertex) -> @location(0) vec4f {
  let coverage = textureSample(media_texture, media_sampler, input.uv).a * input.color.a;
  return weighted_world_position(input, coverage);
}
`;
