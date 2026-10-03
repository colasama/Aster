
struct Settings { value: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: Settings;
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let pixel = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0);
  if (settings.value == 1u) {
    let luminance = dot(pixel.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(vec3f(luminance / (1.0 + luminance)), 1.0);
  }
  if (settings.value == 2u) { return vec4f(vec3f(pixel.a), 1.0); }
  return vec4f(pixel.rgb / (vec3f(1.0) + pixel.rgb), 1.0);
}