override tile_extent: u32 = 16u;

struct Settings {
  viewport: vec2f,
  base_samples: u32,
  adaptive_limit: u32,
  maximum_radius: f32,
  frame_position: f32,
  padding: vec2f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@group(0) @binding(0) var tile_motion_vectors: texture_2d<f32>;
@group(0) @binding(1) var<uniform> tile_settings: Settings;

@fragment fn tile_max_fragment(input: VertexOutput) -> @location(0) vec4f {
  let tile_pixel = vec2i(input.position.xy);
  let source_size = vec2i(textureDimensions(tile_motion_vectors));
  let origin = tile_pixel * i32(tile_extent);
  var maximum = vec2f(0.0);
  var maximum_length = 0.0;
  for (var y = 0; y < i32(tile_extent); y += 1) {
    for (var x = 0; x < i32(tile_extent); x += 1) {
      let pixel = origin + vec2i(x, y);
      if (all(pixel < source_size)) {
        let velocity = textureLoad(tile_motion_vectors, pixel, 0).xy;
        let pixel_length = length(velocity * tile_settings.viewport);
        if (pixel_length > maximum_length) {
          maximum = velocity;
          maximum_length = pixel_length;
        }
      }
    }
  }
  return vec4f(maximum, maximum_length, 1.0);
}

@group(0) @binding(2) var tile_maximum: texture_2d<f32>;

@fragment fn neighbor_max_fragment(input: VertexOutput) -> @location(0) vec4f {
  let center = vec2i(input.position.xy);
  let size = vec2i(textureDimensions(tile_maximum));
  var maximum = vec4f(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sample_pixel = clamp(center + vec2i(x, y), vec2i(0), size - vec2i(1));
      let candidate = textureLoad(tile_maximum, sample_pixel, 0);
      if (candidate.z > maximum.z) { maximum = candidate; }
    }
  }
  return maximum;
}

@group(0) @binding(3) var hdr_scene: texture_2d<f32>;
@group(0) @binding(4) var motion_vectors: texture_2d<f32>;
@group(0) @binding(5) var object_ids: texture_2d<u32>;
@group(0) @binding(6) var neighbor_maximum: texture_2d<f32>;
@group(0) @binding(7) var linear_sampler: sampler;
@group(0) @binding(8) var<uniform> settings: Settings;

fn in_bounds(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}

fn motion_at(pixel: vec2i) -> vec2f {
  let raw = textureLoad(motion_vectors, pixel, 0).xy;
  let pixel_length = length(raw * settings.viewport);
  return raw * min(1.0, settings.maximum_radius / max(pixel_length, 0.0001));
}

fn covers_pixel(source_uv: vec2f, target_uv: vec2f, source_motion: vec2f) -> bool {
  let motion_pixels = source_motion * settings.viewport;
  let length_squared = dot(motion_pixels, motion_pixels);
  if (length_squared < 0.0625) { return false; }
  let target_offset = (target_uv - source_uv) * settings.viewport;
  let along = dot(target_offset, motion_pixels) / length_squared;
  let perpendicular = abs(target_offset.x * motion_pixels.y - target_offset.y * motion_pixels.x) /
    sqrt(length_squared);
  return along >= -settings.frame_position && along <= 1.0 - settings.frame_position &&
    perpendicular <= 1.25;
}

@fragment fn reconstruct_fragment(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(settings.viewport);
  let pixel = clamp(vec2i(input.uv * settings.viewport), vec2i(0), size - vec2i(1));
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  let center_id = textureLoad(object_ids, pixel, 0).x;
  let center_motion = motion_at(pixel);
  let tile_size = vec2i(textureDimensions(neighbor_maximum));
  let tile_pixel = clamp(pixel / i32(tile_extent), vec2i(0), tile_size - vec2i(1));
  let neighbor_motion = textureLoad(neighbor_maximum, tile_pixel, 0).xy;
  let dominant = select(neighbor_motion, center_motion,
    length(center_motion * settings.viewport) > length(neighbor_motion * settings.viewport) * 0.25);
  let pixel_travel = min(length(dominant * settings.viewport), settings.maximum_radius);
  if (pixel_travel < 0.25) { return center; }
  let sample_count = min(settings.adaptive_limit,
    max(settings.base_samples, u32(ceil(pixel_travel / 4.0)) + 1u));
  var accumulated = center;
  var weight_sum = 1.0;
  for (var index = 0u; index < 128u; index += 1u) {
    if (index >= sample_count) { break; }
    let exposure_position = (f32(index) + 0.5) / f32(sample_count) - settings.frame_position;
    let sample_uv = input.uv + dominant * exposure_position;
    if (!in_bounds(sample_uv)) { continue; }
    let sample_pixel = clamp(vec2i(sample_uv * settings.viewport), vec2i(0), size - vec2i(1));
    let sample_motion = motion_at(sample_pixel);
    let sample_id = textureLoad(object_ids, sample_pixel, 0).x;
    let same_surface = center_id != 0u && sample_id == center_id;
    let moving_foreground = sample_id != 0u && covers_pixel(sample_uv, input.uv, sample_motion);
    if (!same_surface && !moving_foreground) { continue; }
    let color = textureSampleLevel(hdr_scene, linear_sampler, sample_uv, 0.0);
    let exposure_weight = max(0.08, 1.0 - abs(exposure_position) * 0.35);
    let coverage_weight = select(0.7, 1.0, same_surface);
    let weight = exposure_weight * coverage_weight * max(color.a, 0.02);
    accumulated += color * weight;
    weight_sum += weight;
  }
  return accumulated / max(weight_sum, 0.0001);
}
