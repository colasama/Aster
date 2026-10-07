struct NativePyramidParameters {
  threshold: f32,
  padding: vec3f,
}

struct NativePyramidSeed {
  @location(0) blur: vec4f,
  @location(1) glow: vec4f,
}

@group(0) @binding(2) var<uniform> pyramid_parameters: NativePyramidParameters;

// Reuse the ordinary downsample taps, applying the bright-pass before accumulation.
@fragment
fn paired_fragment_main(input: VertexOutput) -> NativePyramidSeed {
  let half_texel = vec2f(0.5) / vec2f(textureDimensions(source_tex));
  let taps = downsample_taps(input.uv, half_texel);
  var sum = vec3f(0.0);
  for (var i = 0; i < 5; i += 1) {
    let level = dot(taps[i].rgb, vec3f(0.2126, 0.7152, 0.0722));
    let weight = max(level - pyramid_parameters.threshold, 0.0) / max(level, 0.0001);
    sum += taps[i].rgb * weight * select(1.0, 4.0, i == 0);
  }
  return NativePyramidSeed(vec4f(downsample_rgb(taps), 1.0), vec4f(sum / 8.0, 1.0));
}
