

fn bokeh_field(mode: f32, uv: vec2f, center: vec2f, frame_aspect: f32, source_luminance: f32) -> f32 {
  if mode < 0.5 {
    return clamp(source_luminance, 0.0, 1.0);
  }
  let delta = (uv - center) * vec2f(frame_aspect, 1.0);
  if mode < 1.5 {
    return clamp(abs(delta.y) * 2.0, 0.0, 1.0);
  }
  return clamp(length(delta), 0.0, 1.0);
}

fn bokeh_coc(depth: f32, focus: f32, range: f32, sign: f32, radius: f32) -> f32 {
  return sign * clamp((depth - focus) / range, -1.0, 1.0) * radius;
}

fn bokeh_disc_offset(
  index: u32,
  sample_count: f32,
  blades: f32,
  rotation: f32,
  roundness: f32,
  aspect: f32,
) -> vec2f {
  let radial = sqrt((f32(index) + 0.5) / sample_count);
  let angle = f32(index) * 2.39996323 + rotation;
  var boundary = 1.0;
  if blades < 32.0 {
    let sides = max(blades, 3.0);
    let sector = 6.28318530718 / sides;
    let shifted = angle + 3.14159265359 / sides;
    let local = shifted - floor(shifted / sector) * sector - 3.14159265359 / sides;
    boundary = mix(cos(3.14159265359 / sides) / max(cos(local), 0.0001), 1.0, roundness);
  }
  var direction = vec2f(cos(angle), sin(angle));
  direction.x *= aspect;
  return direction * boundary * radial;
}
