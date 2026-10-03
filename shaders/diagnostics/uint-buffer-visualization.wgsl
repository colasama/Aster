
fn hash_id(id: u32) -> vec3f {
  var value = id ^ (id >> 16u);
  value *= 0x7feb352du;
  value ^= value >> 15u;
  value *= 0x846ca68bu;
  value ^= value >> 16u;
  return vec3f(f32(value & 255u), f32((value >> 8u) & 255u), f32((value >> 16u) & 255u)) / 255.0;
}

fn visualize_id(id: u32) -> vec4f {
  if (id == 0u) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f(hash_id(id), 1.0);
}