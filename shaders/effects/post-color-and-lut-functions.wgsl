

fn hue_color(angle: f32) -> vec3f {
  return 0.5 + 0.5 * cos(angle + vec3f(0.0, 4.188790, 2.094395));
}

fn hue_rotate(color: vec3f, angle: f32) -> vec3f {
  let axis = normalize(vec3f(1.0));
  return color * cos(angle) + cross(axis, color) * sin(angle) + axis * dot(axis, color) * (1.0 - cos(angle));
}

fn rgb_hue(color: vec3f) -> f32 {
  let maximum = max(color.r, max(color.g, color.b));
  let minimum = min(color.r, min(color.g, color.b));
  let chroma = maximum - minimum;
  if chroma < 0.000001 {
    return 0.0;
  }
  var sector = (color.g - color.b) / chroma;
  if maximum == color.g {
    sector = 2.0 + (color.b - color.r) / chroma;
  } else if maximum == color.b {
    sector = 4.0 + (color.r - color.g) / chroma;
  }
  return fract(sector / 6.0 + 1.0) * 6.283185;
}

fn sample_lut_tetrahedral(coordinate: vec3f) -> vec3f {
  let dimensions = textureDimensions(lut_texture, 0);
  let scaled = clamp(coordinate, vec3f(0.0), vec3f(1.0)) * vec3f(dimensions - vec3u(1u));
  let low = vec3u(floor(scaled));
  let high = min(low + vec3u(1u), dimensions - vec3u(1u));
  let fraction = fract(scaled);
  let c000 = textureLoad(lut_texture, vec3i(low), 0).rgb;
  let c100 = textureLoad(lut_texture, vec3i(vec3u(high.x, low.y, low.z)), 0).rgb;
  let c010 = textureLoad(lut_texture, vec3i(vec3u(low.x, high.y, low.z)), 0).rgb;
  let c001 = textureLoad(lut_texture, vec3i(vec3u(low.x, low.y, high.z)), 0).rgb;
  let c110 = textureLoad(lut_texture, vec3i(vec3u(high.x, high.y, low.z)), 0).rgb;
  let c101 = textureLoad(lut_texture, vec3i(vec3u(high.x, low.y, high.z)), 0).rgb;
  let c011 = textureLoad(lut_texture, vec3i(vec3u(low.x, high.y, high.z)), 0).rgb;
  let c111 = textureLoad(lut_texture, vec3i(high), 0).rgb;
  if fraction.x >= fraction.y {
    if fraction.y >= fraction.z {
      return c000 + fraction.x * (c100 - c000) + fraction.y * (c110 - c100) + fraction.z * (c111 - c110);
    }
    if fraction.x >= fraction.z {
      return c000 + fraction.x * (c100 - c000) + fraction.z * (c101 - c100) + fraction.y * (c111 - c101);
    }
    return c000 + fraction.z * (c001 - c000) + fraction.x * (c101 - c001) + fraction.y * (c111 - c101);
  }
  if fraction.x >= fraction.z {
    return c000 + fraction.y * (c010 - c000) + fraction.x * (c110 - c010) + fraction.z * (c111 - c110);
  }
  if fraction.y >= fraction.z {
    return c000 + fraction.y * (c010 - c000) + fraction.z * (c011 - c010) + fraction.x * (c111 - c011);
  }
  return c000 + fraction.z * (c001 - c000) + fraction.y * (c011 - c001) + fraction.x * (c111 - c011);
}
