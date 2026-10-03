
struct DebugSettings { mode: u32, range_min: f32, range_scale: f32, padding: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: DebugSettings;

fn visualize_float_buffer(pixel: vec4f) -> vec4f {
  if (settings.mode == 1u) { return vec4f(pixel.xyz * 0.5 + 0.5, 1.0); }
  if (settings.mode == 4u) {
    return vec4f(clamp((pixel.xyz - settings.range_min) * settings.range_scale, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  return pixel;
}