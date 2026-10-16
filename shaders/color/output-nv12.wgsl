@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> packed: array<u32>;

fn rgb_at(point: vec2<i32>) -> vec3<f32> {
  let last = vec2<i32>(textureDimensions(source)) - vec2<i32>(1);
  return textureLoad(source, clamp(point, vec2<i32>(0), last), 0).rgb;
}

fn code(value: f32) -> u32 {
  return u32(clamp(floor(value + 0.5), 0.0, 255.0));
}

fn luma(index: u32, width: u32) -> u32 {
  let rgb = rgb_at(vec2<i32>(i32(index % width), i32(index / width)));
  return code(16.0 + dot(rgb, vec3<f32>(46.5594, 156.6288, 15.8118)));
}

fn chroma(index: u32, width: u32) -> u32 {
  let point = vec2<i32>(i32(index % (width / 2u)) * 2, i32(index / (width / 2u)) * 2);
  // Horizontal pair averaging and centered vertical bicubic (B=0, C=0.6)
  // reproduce the existing swscale chroma phase without copying its implementation.
  let weights = array<f32, 8>(-0.0140625, -0.0421875, 0.1203125, 0.4359375,
                              0.4359375, 0.1203125, -0.0421875, -0.0140625);
  var rgb = vec3<f32>(0.0);
  for (var tap = 0; tap < 8; tap++) {
    let p = point + vec2<i32>(0, tap - 3);
    rgb += (rgb_at(p) + rgb_at(p + vec2<i32>(1, 0))) * (weights[tap] * 0.5);
  }
  let u = code(128.0 + dot(rgb, vec3<f32>(-25.6641526, -86.3358474, 112.0)));
  let v = code(128.0 + dot(rgb, vec3<f32>(112.0, -101.730251, -10.269749)));
  return u | (v << 8u);
}

@compute @workgroup_size(64)
fn convert(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(source);
  // Texture copies require 256-byte rows. Initialize padding without sampling it.
  let stride = ((size.x + 255u) / 256u) * 256u;
  let row = (id.x * 4u) / stride;
  let column = (id.x * 4u) % stride;
  if (row < size.y) {
    var value = 0u;
    for (var byte = 0u; byte < 4u; byte++) {
      if (column + byte < size.x) {
        value |= luma(row * size.x + column + byte, size.x) << (byte * 8u);
      }
    }
    packed[id.x] = value;
  }
  if (row < size.y / 2u) {
    var value = 0u;
    let pair = row * (size.x / 2u) + column / 2u;
    if (column < size.x) { value = chroma(pair, size.x); }
    if (column + 2u < size.x) { value |= chroma(pair + 1u, size.x) << 16u; }
    packed[stride * size.y / 4u + id.x] = value;
  }
}
