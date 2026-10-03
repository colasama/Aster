

fn pixel_at(uv: vec2f) -> vec2i {
  let size = vec2i(settings.viewport);
  return clamp(vec2i(uv * settings.viewport), vec2i(0), size - vec2i(1));
}

fn is_selected(id: u32) -> bool {
  return settings.selected_id != 0u && id == settings.selected_id;
}

fn selection_glow(pixel: vec2i) -> f32 {
  let size = vec2i(settings.viewport);
  let offsets = array<vec2i, 12>(
    vec2i(-2, 0), vec2i(2, 0), vec2i(0, -2), vec2i(0, 2),
    vec2i(-4, -4), vec2i(4, -4), vec2i(-4, 4), vec2i(4, 4),
    vec2i(-7, 0), vec2i(7, 0), vec2i(0, -7), vec2i(0, 7),
  );
  var glow = 0.0;
  for (var index = 0u; index < 12u; index += 1u) {
    let sample_pixel = clamp(pixel + offsets[index], vec2i(0), size - vec2i(1));
    let weight = select(0.28, select(0.52, 0.86, index < 4u), index < 8u);
    glow = max(glow, select(0.0, weight, is_selected(textureLoad(object_ids, sample_pixel, 0).x)));
  }
  return glow;
}

fn vector_blur(uv: vec2f, pixel: vec2i) -> vec4f {
  let center = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0);
  let raw_motion = textureLoad(motion_vectors, pixel, 0).xy * settings.motion.x;
  let pixel_length = length(raw_motion * settings.viewport);
  let motion = raw_motion * min(1.0, 64.0 / max(pixel_length, 0.0001));
  if (pixel_length < 0.25) { return center; }
  var accumulated = vec4f(0.0);
  var weight_sum = 0.0;
  for (var index = 0u; index < 9u; index += 1u) {
    let position = f32(index) / 8.0 - 0.5;
    let weight = 1.0 - abs(position) * 1.25;
    let sample_uv = clamp(uv + motion * position, vec2f(0.0), vec2f(1.0));
    accumulated += textureSampleLevel(hdr_scene, linear_sampler, sample_uv, 0.0) * weight;
    weight_sum += weight;
  }
  return accumulated / weight_sum;
}

fn straight_rgb(premultiplied: vec4f) -> vec3f {
  let straight = premultiplied.rgb / max(premultiplied.a, 0.00001);
  return select(vec3f(0.0), straight, premultiplied.a > 0.00001);
}

fn display_premultiplied(premultiplied: vec4f) -> vec4f {
  let straight = straight_rgb(premultiplied);
  return vec4f(linear_to_srgb(straight) * premultiplied.a, premultiplied.a);
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let pixel = pixel_at(input.uv);
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  if (settings.mode == 1u && settings.selected_id != 0u) {
    let selected = is_selected(textureLoad(object_ids, pixel, 0).x);
    let straight = straight_rgb(center);
    let luminance = dot(straight, vec3f(0.2126, 0.7152, 0.0722));
    let isolated = mix(vec3f(luminance), straight, select(0.18, 1.0, selected));
    let glow = select(selection_glow(pixel), 0.22, selected);
    let effected = vec4f((isolated + vec3f(0.05, 0.42, 0.72) * glow) * center.a, center.a);
    return display_premultiplied(effected);
  }
  if (settings.mode == 2u) { return display_premultiplied(vector_blur(input.uv, pixel)); }
  return display_premultiplied(center);
}
