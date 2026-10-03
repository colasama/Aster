
      case 66u: {
        let tile_size = max(effect.header.y, 1.0);
        let center = vec2f(effect.header.z, effect.header.w);
        let scale = max(effect.p0.y, 0.01);
        let pixel = rotate2((uv - center) * resolution, -effect.p0.x) / scale;
        let axial_x = (0.57735027 * pixel.x - 0.33333333 * pixel.y) / tile_size;
        let axial_z = 0.66666667 * pixel.y / tile_size;
        let cube = vec3f(axial_x, -axial_x - axial_z, axial_z);
        var rounded = round(cube);
        let difference = abs(rounded - cube);
        if difference.x > difference.y && difference.x > difference.z {
          rounded.x = -rounded.y - rounded.z;
        } else if difference.y > difference.z {
          rounded.y = -rounded.x - rounded.z;
        } else {
          rounded.z = -rounded.x - rounded.y;
        }
        let hex_pixel = vec2f(
          tile_size * 1.7320508 * (rounded.x + rounded.z * 0.5),
          tile_size * 1.5 * rounded.z,
        );
        let tiled_uv = center + rotate2(hex_pixel * scale, effect.p0.x) / resolution;
        uv = mix(uv, tiled_uv, effect.p0.z);
      }
      case 72u: {
        let center = vec2f(effect.header.w, effect.p0.x);
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = (uv - center) * aspect;
        let polar_uv = vec2f(
          fract(atan2(delta.y, delta.x) / 6.283185 + 0.5 + effect.p0.y / 6.283185),
          clamp(length(delta) * 2.0, 0.0, 1.0),
        );
        let rectangular_angle = (uv.x - center.x) * 6.283185 + effect.p0.y;
        let rectangular_radius = clamp(uv.y - center.y + 0.5, 0.0, 1.0) * 0.5;
        let rectangular_uv = center
          + vec2f(cos(rectangular_angle), sin(rectangular_angle)) * rectangular_radius / aspect;
        let remapped = select(polar_uv, rectangular_uv, effect.header.y > 0.5);
        uv = mix(uv, remapped, effect.header.z);
      }
      case 73u: {
        let shifted = uv - effect.header.yz / resolution;
        uv = select(clamp(shifted, vec2f(0.0), vec2f(1.0)), fract(shifted + vec2f(1.0)), effect.header.w > 0.5);
      }
      case 74u: {
        let center = effect.header.yz;
        let delta = (uv - center) * resolution;
        let distance = select(length(delta), max(abs(delta.x), abs(delta.y)), effect.p0.z > 0.5);
        let region = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        let magnified = center + delta / max(effect.header.w, 0.01) / resolution;
        uv = mix(uv, magnified, region);
      }
      case 75u: {
        let center = effect.header.yz;
        let delta = (uv - center) * resolution;
        let distance = length(delta);
        let direction = delta / max(distance, 0.0001);
        let falloff = 1.0 - smoothstep(effect.p0.y * 0.7, effect.p0.y, distance);
        let phase = distance / max(effect.p0.x, 1.0) * 6.283185 + effect.p0.z + time * effect.p0.w;
        uv += direction * sin(phase) * effect.header.w * falloff / resolution;
      }
      case 76u: {
        let upper_left = effect.header.yz;
        let upper_right = vec2f(effect.header.w, effect.p0.x);
        let lower_left = effect.p0.yz;
        let lower_right = vec2f(effect.p0.w, effect.p1.x);
        let top = mix(upper_left, upper_right, uv.x);
        let bottom = mix(lower_left, lower_right, uv.x);
        let pinned = mix(top, bottom, uv.y);
        uv = mix(uv, pinned, effect.p1.y);
      }
      case 87u: {
        let grain = max(effect.header.w, 1.0);
        let cell = floor(input.position.xy / grain);
        let evolution = effect.p0.y + time * 0.03;
        let random_offset = vec2f(
          hash(cell + vec2f(effect.p0.x + evolution)),
          hash(cell + vec2f(effect.p0.x + evolution + 83.1)),
        ) * 2.0 - vec2f(1.0);
        uv += random_offset * effect.header.yz / resolution;
      }
      case 124u: {
        let center = effect.header.yz;
        let delta = (uv - center) * resolution;
        let distance = length(delta);
        let radius = max(effect.header.w, 0.0001);
        let region = 1.0 - smoothstep(radius * 0.82, radius, distance);
        let profile = pow(clamp(1.0 - distance / radius, 0.0, 1.0), 1.5);
        let distorted = center + delta * (1.0 - effect.p0.x * profile * 0.72) / resolution;
        uv = mix(uv, distorted, region);
      }
      case 125u: {
        let center = vec2f(effect.header.w, effect.p0.x);
        let scale = max(effect.p0.y, 0.01);
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let centered_uv = (uv - center) * aspect / scale;
        let radius_squared = dot(centered_uv, centered_uv);
        let strength = tan(clamp(effect.header.y, 0.0, 0.99) * 1.5707963) * 0.16;
        let signed_strength = select(strength, -strength, effect.header.z > 0.5);
        uv = center + centered_uv * (1.0 + signed_strength * radius_squared) * scale / aspect;
      }
      case 126u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let axis = end - start;
        let axis_length = max(length(axis), 0.0001);
        let direction = axis / axis_length;
        let normal = vec2f(-direction.y, direction.x);
        let progress = dot(uv * resolution - start, direction) / axis_length;
        let window = sin(clamp(progress, 0.0, 1.0) * 3.14159265)
          * step(0.0, progress) * step(progress, 1.0);
        uv -= normal * window * effect.p0.y / resolution;
      }
      case 127u: {
        let center = effect.header.yz;
        let radius = max(effect.header.w, 1.0);
        let local = rotate2((uv - center) * resolution, -effect.p0.x);
        let normalized_x = clamp(local.x / radius, -0.999, 0.999);
        let cylindrical_x = asin(normalized_x) * radius;
        let wrapped = vec2f(mix(local.x, cylindrical_x, effect.p0.y), local.y);
        let projected = center + rotate2(wrapped, effect.p0.x) / resolution;
        uv = mix(uv, projected, step(abs(local.x), radius));
      }
      case 128u: {
        let center = effect.header.yz;
        let radius = max(effect.header.w, 1.0);
        let local = (uv - center) * resolution / max(effect.p0.y, 0.01);
        let distance = length(local);
        let depth = sqrt(max(radius * radius - distance * distance, 0.0));
        let longitude = atan2(local.x, depth) + effect.p0.x;
        let latitude = asin(clamp(local.y / radius, -1.0, 1.0));
        let spherical = center + vec2f(longitude / 3.14159265, latitude / 1.5707963)
          * radius / resolution;
        uv = mix(uv, spherical, 1.0 - smoothstep(radius * 0.98, radius, distance));
      }
      case 129u: {
        let horizontal = sin(uv.y * effect.p0.x * 6.283185 + effect.p0.y) * effect.header.y;
        let vertical = sin(uv.x * effect.header.w * 6.283185 + effect.p0.y) * effect.header.z;
        uv += vec2f(horizontal, vertical) * effect.p0.z / resolution;
      }
      case 130u: {
        var local = rotate2(uv - vec2f(0.5), -effect.p0.y);
        if effect.header.y < 0.5 {
          local.y += (local.x * local.x - 0.25) * effect.header.z;
        } else if effect.header.y < 1.5 {
          local.y += sin((local.x + 0.5) * 6.283185) * effect.header.z * 0.28;
        } else if effect.header.y < 2.5 {
          local += vec2f(
            sin((local.y + 0.5) * 6.283185),
            sin((local.x + 0.5) * 6.283185),
          ) * effect.header.z * 0.2;
        } else {
          let radius_squared = dot(local, local) * 4.0;
          local *= 1.0 + effect.header.z * (1.0 - radius_squared) * 0.6;
        }
        local += vec2f(local.y * effect.header.w, local.x * effect.p0.x) * 0.5;
        uv = rotate2(local, effect.p0.y) + vec2f(0.5);
      }
      case 131u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let diagonal = length(resolution);
        let pixel = (uv - vec2f(0.5)) * resolution;
        let coordinate = dot(pixel, direction);
        let boundary = (effect.header.y - 0.5) * diagonal;
        let fold_distance = coordinate - boundary;
        if fold_distance > 0.0 {
          let curl = min(fold_distance / max(effect.header.w, 1.0), 3.14159265);
          let curled_coordinate = boundary + sin(curl) * effect.header.w;
          uv += direction * (curled_coordinate - coordinate) / resolution;
        }
      }
