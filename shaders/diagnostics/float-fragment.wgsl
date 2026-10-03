
struct Settings { range_min: f32, range_scale: f32, mode: u32, padding: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: Settings;
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let pixel = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0);
  if (pixel.a == 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (settings.mode == 0u) { return vec4f(pixel.xyz * 0.5 + 0.5, 1.0); }
  if (settings.mode == 2u) {
    let motion_pixels = pixel.xy * size;
    let direction = clamp(vec2f(0.5) + motion_pixels / 64.0, vec2f(0.0), vec2f(1.0));
    return vec4f(direction, clamp(length(motion_pixels) / 32.0, 0.0, 1.0), 1.0);
  }
  return vec4f(clamp((pixel.xyz - settings.range_min) * settings.range_scale, vec3f(0.0), vec3f(1.0)), 1.0);
}