
struct Settings { range_min: f32, range_scale: f32, mode: u32, padding: u32 }
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> settings: Settings;
fn hash_id(id: u32) -> vec3f {
  var value = id ^ (id >> 16u); value *= 0x7feb352du; value ^= value >> 15u;
  value *= 0x846ca68bu; value ^= value >> 16u;
  return vec3f(f32(value & 255u), f32((value >> 8u) & 255u), f32((value >> 16u) & 255u)) / 255.0;
}
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let id = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0).x;
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(hash_id(id), 1.0), id != 0u);
}