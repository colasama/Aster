

fn surface_at(uv: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(world_position));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  return textureLoad(world_position, pixel, 0);
}

fn transparent_surface_at(uv: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(transparent_world_position));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  let accumulated = textureLoad(transparent_world_position, pixel, 0);
  return select(
    surface_at(uv),
    vec4f(accumulated.xyz / max(accumulated.a, 0.00001), accumulated.a),
    accumulated.a > 0.00001,
  );
}

fn peeled_surface_at(uv: vec2f) -> vec4f {
  if (settings.optics.z < 1.5) { return vec4f(0.0); }
  let size = vec2i(textureDimensions(peeled_world_position));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  return textureLoad(peeled_world_position, pixel, 0);
}

fn front_color_at(uv: vec2f) -> vec4f {
  let raw = textureSampleLevel(front_layer_color, linear_sampler, uv, 0.0);
  let canonical = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0);
  return select(raw, canonical, raw.a >= 0.999 || settings.optics.z < 0.5);
}

fn peeled_color_at(uv: vec2f) -> vec4f {
  if (settings.optics.z < 1.5) { return vec4f(0.0); }
  let raw = textureSampleLevel(peeled_layer_color, linear_sampler, uv, 0.0);
  let front = front_color_at(uv);
  let scene = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0);
  let after_front = 1.0 - clamp(front.a, 0.0, 1.0);
  let canonical_behind_front = max((scene - front) / max(after_front, 0.00001), vec4f(0.0));
  return select(raw, canonical_behind_front, raw.a >= 0.999 && after_front > 0.00001);
}

fn residual_color_at(uv: vec2f) -> vec4f {
  let scene = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0);
  let front = front_color_at(uv);
  let peeled = peeled_color_at(uv);
  let after_front = 1.0 - clamp(front.a, 0.0, 1.0);
  if (settings.optics.z < 0.5) { return vec4f(0.0); }
  if (settings.optics.z < 1.5) {
    return select(vec4f(0.0), max((scene - front) / max(after_front, 0.00001), vec4f(0.0)), after_front > 0.00001);
  }
  let transmittance = after_front * (1.0 - clamp(peeled.a, 0.0, 1.0));
  let remainder = scene - front - peeled * after_front;
  return select(vec4f(0.0), max(remainder / max(transmittance, 0.00001), vec4f(0.0)), transmittance > 0.00001);
}

fn layer_color_at(uv: vec2f, layer: u32) -> vec4f {
  if (layer == 0u) { return front_color_at(uv); }
  if (layer == 1u) { return peeled_color_at(uv); }
  return residual_color_at(uv);
}

fn view_depth(surface: vec4f) -> f32 {
  let forward = normalize(select(vec3f(0.0, 0.0, 1.0), settings.camera.xyz, length(settings.camera.xyz) > 0.00001));
  return max(dot(surface.xyz - settings.lens.xyz, forward), 0.0001);
}

fn circle_of_confusion(surface: vec4f) -> f32 {
  if (surface.a <= 0.0) { return 0.0; }
  let depth = view_depth(surface);
  let focus_error = depth - settings.camera.w;
  let defocused = max(abs(focus_error) - settings.optics.x * 0.5, 0.0);
  let aperture_pixels = settings.optics.y;
  let focus_scale = settings.optics.w / max(settings.camera.w, 0.001);
  let depth_scale = defocused / depth;
  let side_level = select(settings.blur.z, settings.blur.y, focus_error < 0.0);
  let radius = min(
    aperture_pixels * 0.5 * focus_scale * depth_scale * settings.blur.x * side_level,
    settings.blur.w,
  );
  return select(radius, -radius, focus_error < 0.0);
}

fn iris_blades(shape: f32) -> f32 {
  if (shape >= 9.5) { return 64.0; }
  if (shape < 2.5) { return 4.0; }
  if (shape < 3.5) { return 3.0; }
  return shape + 1.0;
}

fn iris_boundary(angle: f32) -> f32 {
  let blades = iris_blades(settings.iris.x);
  if (blades > 32.0) { return 1.0; }
  let sector = 6.28318530718 / blades;
  let shifted = angle + 3.14159265359 / blades;
  let local_angle = shifted - floor(shifted / sector) * sector - 3.14159265359 / blades;
  let polygon = cos(3.14159265359 / blades) / max(cos(local_angle), 0.0001);
  return mix(polygon, 1.0, settings.iris.z);
}

fn iris_uv(uv: vec2f, radius: f32, index: u32, sample_count: f32) -> vec2f {
  let unit_radius = sqrt((f32(index) + 0.5) / sample_count);
  let angle = f32(index) * 2.39996323 + settings.iris.y;
  var direction = vec2f(cos(angle), sin(angle));
  let shape_rotation = select(0.0, 0.78539816339, settings.iris.x > 1.5 && settings.iris.x < 2.5);
  let shape_angle = angle + shape_rotation;
  direction = vec2f(cos(shape_angle), sin(shape_angle));
  direction.x *= settings.iris.w;
  let offset = direction * unit_radius * iris_boundary(shape_angle) * radius /
    settings.viewport.xy;
  return clamp(uv + offset, vec2f(0.0), vec2f(1.0));
}

fn straight_rgb(premultiplied: vec4f) -> vec3f {
  return select(vec3f(0.0), premultiplied.rgb / max(premultiplied.a, 0.00001), premultiplied.a > 0.00001);
}

fn display_premultiplied(premultiplied: vec4f) -> vec4f {
  return vec4f(linear_to_srgb(straight_rgb(premultiplied)) * premultiplied.a, premultiplied.a);
}

fn highlight_sample(premultiplied: vec4f) -> vec4f {
  if (premultiplied.a <= 0.00001) { return premultiplied; }
  let straight = premultiplied.rgb / premultiplied.a;
  let luminance = dot(straight, vec3f(0.2126, 0.7152, 0.0722));
  let saturated = mix(vec3f(luminance), straight, settings.highlights.w);
  let highlight_amount = smoothstep(settings.highlights.z, settings.highlights.z + 0.25, luminance);
  let highlight_color = mix(straight, saturated, highlight_amount);
  let gain = 1.0 + max(luminance - settings.highlights.z, 0.0) * settings.highlights.y * 8.0;
  return vec4f(highlight_color * premultiplied.a * gain, premultiplied.a);
}

fn diffraction_weight(index: u32, sample_count: f32) -> f32 {
  let radial_position = sqrt((f32(index) + 0.5) / sample_count);
  let boundary_profile = 5.0 * pow(radial_position, 8.0);
  return mix(1.0, boundary_profile, settings.highlights.x);
}

fn bokeh_sample(uv: vec2f, radius: f32, index: u32, sample_count: f32, layer: u32) -> vec4f {
  let sample_uv = iris_uv(uv, radius, index, sample_count);
  return highlight_sample(layer_color_at(sample_uv, layer));
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  let surface = surface_at(input.uv);
  if (settings.viewport.z < 1.5) {
    let depth_distance = max(view_depth(surface) - settings.lens.w, 0.0);
    let fog_amount = select(0.0, 1.0 - exp(-depth_distance * settings.fog.w), surface.a > 0.0);
    let straight = mix(straight_rgb(center), settings.fog.rgb, clamp(fog_amount, 0.0, 0.96));
    return vec4f(linear_to_srgb(straight) * center.a, center.a);
  }
  let peeled = peeled_surface_at(input.uv);
  let transparent = transparent_surface_at(input.uv);
  let front_coc = circle_of_confusion(surface);
  let peeled_coc = circle_of_confusion(peeled);
  let fallback_coc = circle_of_confusion(transparent);
  let front_radius = abs(front_coc);
  let peeled_radius = abs(peeled_coc);
  let fallback_radius = abs(fallback_coc);
  let radius = max(front_radius, max(peeled_radius, fallback_radius));
  if (radius < 0.25) { return display_premultiplied(center); }
  let center_depth = view_depth(surface);
  let sample_count = clamp(settings.viewport.w, 8.0, 64.0);
  let front_center = front_color_at(input.uv);
  let peeled_center = peeled_color_at(input.uv);
  let fallback_center = residual_color_at(input.uv);
  var accumulated_front = front_center;
  var accumulated_peeled = peeled_center;
  var accumulated_fallback = fallback_center;
  var weight_sum = 1.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (f32(index) >= sample_count) { break; }
    let sample_uv = iris_uv(input.uv, front_radius, index, sample_count);
    let sample_surface = surface_at(sample_uv);
    let sample_depth = view_depth(sample_surface);
    let sample_coc = circle_of_confusion(sample_surface);
    var weight = 1.0 - (f32(index) / sample_count) * 0.35;
    if (front_coc > 0.0 && sample_depth < center_depth && abs(sample_coc) < front_radius) {
      weight *= 0.08;
    }
    weight *= diffraction_weight(index, sample_count);
    accumulated_front += bokeh_sample(input.uv, front_radius, index, sample_count, 0u) * weight;
    accumulated_peeled += bokeh_sample(input.uv, peeled_radius, index, sample_count, 1u) * weight;
    accumulated_fallback += bokeh_sample(input.uv, fallback_radius, index, sample_count, 2u) * weight;
    weight_sum += weight;
  }
  let front_result = mix(
    front_center,
    accumulated_front / weight_sum,
    smoothstep(0.25, 1.5, front_radius),
  );
  let peeled_result = mix(
    peeled_center,
    accumulated_peeled / weight_sum,
    smoothstep(0.25, 1.5, peeled_radius),
  );
  let fallback_result = mix(
    fallback_center,
    accumulated_fallback / weight_sum,
    smoothstep(0.25, 1.5, fallback_radius),
  );
  let behind_front = peeled_result + fallback_result * (1.0 - peeled_result.a);
  return display_premultiplied(front_result + behind_front * (1.0 - front_result.a));
}
