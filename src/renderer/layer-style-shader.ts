export const layerStyleShaderFunctions = /* wgsl */ `
fn style_alpha_at(uv: vec2f) -> f32 {
  let a = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0).a;
  return select(0.0, a, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
}

// Bounded Gaussian kernel: work is independent of user radius. Samples outside
// the composition are transparent, not edge-clamped replicas of the glyph.
fn style_alpha_field(uv: vec2f, radius: f32, spread: f32, resolution: vec2f) -> f32 {
  if radius <= 0.01 { return style_alpha_at(uv); }
  var total = 0.0;
  var weight_sum = 0.0;
  var maximum = 0.0;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let p = vec2f(f32(x),f32(y))/4.0;
      let weight = exp(-4.5*dot(p,p));
      let a = style_alpha_at(uv+p*radius/resolution);
      total += a*weight;
      weight_sum += weight;
      maximum = max(maximum,a);
    }
  }
  return mix(total/weight_sum, maximum, clamp(spread,0.0,1.0));
}

fn style_under(color: vec3f, alpha: f32, style_color: vec3f, style_alpha: f32) -> vec4f {
  let behind = clamp(style_alpha,0.0,1.0)*(1.0-alpha);
  let result_alpha = alpha+behind;
  return vec4f((color*alpha+style_color*behind)/max(result_alpha,0.00001),result_alpha);
}
`;
