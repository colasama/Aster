
fn linear_to_srgb(color: vec3f) -> vec3f {
  let bounded = clamp(color, vec3f(0.0), vec3f(1.0));
  return select(
    bounded * 12.92,
    1.055 * pow(bounded, vec3f(1.0 / 2.4)) - vec3f(0.055),
    bounded > vec3f(0.0031308),
  );
}
