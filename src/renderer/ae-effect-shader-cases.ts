export const aeWarpShaderCases = /* wgsl */ `
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
`;

export const aePixelShaderCases = /* wgsl */ `
      case 65u: {
        let grid_size = max(effect.header.y, 2.0);
        let twist = effect.p0.x;
        let screen_center = resolution * 0.5;
        let twisted_pixel = rotate2(input.position.xy - screen_center, -twist) + screen_center;
        let cell = floor(twisted_pixel / grid_size);
        let local = fract(twisted_pixel / grid_size) - vec2f(0.5);
        let scatter_direction = vec2f(hash(cell) - 0.5, hash(cell + vec2f(37.1, 91.7)) - 0.5);
        let cell_center = (cell + vec2f(0.5)) * grid_size + scatter_direction * effect.header.w;
        let sample_pixel = rotate2(cell_center - screen_center, twist) + screen_center;
        let sampled = textureSample(hdr_scene, linear_sampler, sample_pixel / resolution).rgb;
        let normalized_radius = length(local) * 2.0 / max(effect.header.z, 0.001);
        let sphere = 1.0 - smoothstep(0.96, 1.0, normalized_radius);
        let lighting = 0.35 + 0.65 * sqrt(max(1.0 - normalized_radius * normalized_radius, 0.0));
        let rebuilt = sampled * lighting * sphere;
        color = mix(color, rebuilt, effect.p0.y);
        alpha = mix(alpha, alpha * sphere, effect.p0.y);
      }
      case 67u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let segment = end - start;
        let progress = clamp(dot(input.position.xy - start, segment) / max(dot(segment, segment), 0.0001), 0.0, 1.0);
        let distance = length(input.position.xy - (start + segment * progress));
        let beam = 1.0 - smoothstep(effect.p0.y, effect.p0.y + effect.p0.z + 0.0001, distance);
        let beam_color = mix(effect.p1.xyz, effect.p2.xyz, progress);
        color += beam_color * beam * effect.p0.w * effect.p1.w;
        alpha = max(alpha, beam * effect.p1.w);
      }
      case 68u: {
        let center = effect.header.yz * resolution;
        let distance = length(input.position.xy - center);
        let spacing = max(min(resolution.x, resolution.y) / max(effect.header.w, 0.1), 1.0);
        let wave_phase = fract((distance - effect.p0.x * effect_time) / spacing);
        let wave_distance = min(wave_phase, 1.0 - wave_phase) * spacing;
        let wave = 1.0 - smoothstep(effect.p0.y, effect.p0.y + 1.5, wave_distance);
        let radial_fade = mix(1.0, clamp(1.0 - distance / max(min(resolution.x, resolution.y) * 0.65, 1.0), 0.0, 1.0), effect.p0.w);
        let wave_color = effect.p1.xyz * wave * radial_fade * effect.p0.z;
        color += wave_color * effect.p1.w;
        alpha = max(alpha, wave * radial_fade * effect.p1.w);
      }
      case 69u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let segment = end - start;
        let segment_length = max(length(segment), 0.0001);
        let direction = segment / segment_length;
        let normal = vec2f(-direction.y, direction.x);
        let progress = clamp(dot(input.position.xy - start, direction) / segment_length, 0.0, 1.0);
        let noise_position = vec2f(progress * max(effect.p0.z, 1.0), effect.p0.w + effect_time * 0.7);
        let jagged = (fractal_noise(noise_position) - 0.5) * effect.p0.y * sin(progress * 3.14159265);
        let bolt_point = start + segment * progress + normal * jagged;
        let distance = length(input.position.xy - bolt_point);
        let core = 1.0 - smoothstep(effect.p1.x, effect.p1.x + 1.25, distance);
        let halo = 1.0 - smoothstep(effect.p1.x, effect.p1.x + effect.p1.y + 0.0001, distance);
        let bolt_color = vec3f(effect.p1.z, effect.p1.w, effect.p2.x);
        let lightning = core * 2.0 + halo * 0.7;
        color += bolt_color * lightning * effect.p2.y;
        alpha = max(alpha, clamp(lightning, 0.0, 1.0) * effect.p2.y);
      }
      case 70u: {
        let center = effect.header.yz * resolution;
        let distance = length(input.position.xy - center);
        let feather = max(effect.p0.y, 0.75);
        let ring_distance = abs(distance - effect.header.w);
        let ring = 1.0 - smoothstep(effect.p0.x, effect.p0.x + feather, ring_distance);
        let disk = 1.0 - smoothstep(effect.header.w, effect.header.w + feather, distance);
        let shape = select(ring, disk, effect.p0.z > 0.5);
        let circle_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        let amount = shape * effect.p1.z * effect.p1.w;
        color += circle_color * amount;
        alpha = max(alpha, amount);
      }
      case 71u: {
        let center = effect.header.yz * resolution;
        let delta = input.position.xy - center;
        let distance = length(delta);
        let angle = atan2(delta.y, delta.x) + effect.p0.y;
        let spoke = pow(max(cos(angle * effect.header.w * 0.5), 0.0), max(effect.p0.z, 0.5));
        let radial = 1.0 - smoothstep(effect.p0.x * 0.08, effect.p0.x, distance);
        let center_glow = exp(-distance / max(effect.p0.x * 0.12, 1.0));
        let burst = (spoke * radial + center_glow * 0.7) * effect.p0.w;
        color += effect.p1.xyz * burst * effect.p1.w;
        alpha = max(alpha, clamp(burst, 0.0, 1.0) * effect.p1.w);
      }
      case 77u: {
        let center = effect.header.yz * resolution;
        let delta = input.position.xy - center;
        let distance = length(delta);
        let scale = max(effect.p0.x, 1.0);
        let halo = exp(-distance / (scale * 0.42));
        let ring = 1.0 - smoothstep(3.0, 12.0, abs(distance - scale * 0.72));
        let streak_direction = vec2f(cos(effect.p0.y), sin(effect.p0.y));
        let streak_normal = vec2f(-streak_direction.y, streak_direction.x);
        let across = abs(dot(delta, streak_normal));
        let along = abs(dot(delta, streak_direction));
        let anamorphic = 1.0 - smoothstep(1.5, 8.0 + effect.p0.z * 9.0, across);
        let streak = anamorphic * exp(-along / (scale * (1.2 + effect.p0.z)));
        let lens_axis = resolution * vec2f(0.5) - center;
        let ghost_a = exp(-length(input.position.xy - (center + lens_axis * 0.72)) / (scale * 0.16));
        let ghost_b = exp(-length(input.position.xy - (center + lens_axis * 1.34)) / (scale * 0.1));
        let flare = halo * 1.4 + ring * 0.42 + streak * 0.6 + ghost_a * 0.55 + ghost_b * 0.38;
        let flare_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += flare_color * flare * effect.header.w * effect.p1.z;
        alpha = max(alpha, clamp(flare, 0.0, 1.0) * effect.p1.z);
      }
      case 78u: {
        let position = input.position.xy / max(effect.header.y, 1.0) + vec2f(effect.header.w * 0.07 + effect_time * 0.03);
        let base_cell = floor(position);
        let local = fract(position);
        var nearest = 10.0;
        var second_nearest = 10.0;
        for (var cell_y = -1; cell_y <= 1; cell_y += 1) {
          for (var cell_x = -1; cell_x <= 1; cell_x += 1) {
            let neighbor = vec2f(f32(cell_x), f32(cell_y));
            let cell = base_cell + neighbor;
            let point = neighbor + vec2f(hash(cell), hash(cell + vec2f(71.3, 19.7)));
            let candidate = length(point - local);
            if candidate < nearest {
              second_nearest = nearest;
              nearest = candidate;
            } else if candidate < second_nearest {
              second_nearest = candidate;
            }
          }
        }
        var cell_value = smoothstep(0.02, 0.18, second_nearest - nearest);
        if effect.p0.x > 0.5 && effect.p0.x < 1.5 {
          cell_value = pow(clamp(1.0 - nearest, 0.0, 1.0), max(effect.header.z, 0.01));
        } else if effect.p0.x > 1.5 {
          cell_value = 1.0 - smoothstep(0.12, 0.72, nearest * max(effect.header.z, 0.01));
        } else {
          cell_value = pow(cell_value, 1.0 / max(effect.header.z, 0.01));
        }
        cell_value = select(cell_value, 1.0 - cell_value, effect.p0.y > 0.5);
        let cell_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        let border_color = effect.p1.yzw;
        color = mix(color, mix(border_color, cell_color, cell_value), effect.p2.x);
      }
      case 79u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let normal = vec2f(-direction.y, direction.x);
        let field = vec2f(
          dot(input.position.xy, normal),
          dot(input.position.xy, direction) - effect_time * effect.header.z,
        );
        let grid = vec2f(max(24.0 / max(effect.header.y, 0.05), 4.0), max(effect.p0.x * 2.4, 40.0));
        let cell = floor(field / grid);
        let random_offset = vec2f(hash(cell + vec2f(effect.p0.z)), hash(cell + vec2f(effect.p0.z + 47.0)));
        let local = fract(field / grid + random_offset) - vec2f(0.5);
        let cross_distance = abs(local.x * grid.x);
        let along_distance = abs(local.y * grid.y);
        let streak = (1.0 - smoothstep(effect.p0.y, effect.p0.y + 1.0, cross_distance))
          * (1.0 - smoothstep(effect.p0.x * 0.5, effect.p0.x * 0.5 + 2.0, along_distance));
        let rain_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += rain_color * streak * effect.p1.z;
        alpha = max(alpha, streak * effect.p1.z);
      }
      case 80u: {
        let grid_size = max(48.0 / max(effect.header.y, 0.05), 7.0);
        let animated = input.position.xy
          - vec2f(effect.p0.x * effect_time, effect.header.z * effect_time)
          + vec2f(sin(input.position.y / 90.0 + effect_time) * effect.p0.y, 0.0);
        let cell = floor(animated / grid_size);
        let depth = 0.35 + hash(cell + vec2f(effect.p0.z)) * 0.65;
        let center = vec2f(
          hash(cell + vec2f(effect.p0.z + 11.0)),
          hash(cell + vec2f(effect.p0.z + 83.0)),
        );
        let local = fract(animated / grid_size);
        let distance = length(local - center) * grid_size;
        let radius = effect.header.w * depth;
        let flake = (1.0 - smoothstep(radius, radius + 1.25, distance)) * depth;
        let snow_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += snow_color * flake * effect.p1.z;
        alpha = max(alpha, flake * effect.p1.z);
      }
      case 81u: {
        let block = floor(input.position.xy / max(effect.header.zw, vec2f(2.0)));
        let threshold = hash(block + vec2f(effect.p0.y));
        let keep = smoothstep(
          effect.header.y - effect.p0.x,
          effect.header.y + effect.p0.x + 0.0001,
          threshold,
        );
        alpha *= keep;
      }
      case 82u: {
        let center = vec2f(effect.header.w, effect.p0.x) * resolution;
        let delta = input.position.xy - center;
        var distance = length(delta);
        if effect.header.z > 0.5 && effect.header.z < 1.5 {
          distance = max(abs(delta.x), abs(delta.y));
        } else if effect.header.z > 1.5 {
          distance = abs(delta.x) + abs(delta.y);
        }
        let maximum = length(resolution) * 0.55;
        let boundary = (1.0 - effect.header.y) * maximum;
        var keep = 1.0 - smoothstep(boundary - effect.p0.y, boundary + effect.p0.y + 0.0001, distance);
        keep = select(keep, 1.0 - keep, effect.p0.z > 0.5);
        alpha *= keep;
      }
      case 83u: {
        let horizontal = effect.header.z < 0.5;
        let coordinate = select(uv.y, uv.x, horizontal);
        let axis_size = select(resolution.y, resolution.x, horizontal);
        let distance = abs(coordinate - effect.header.w) * axis_size;
        let boundary = (1.0 - effect.header.y) * axis_size * 0.5;
        var keep = 1.0 - smoothstep(boundary - effect.p0.x, boundary + effect.p0.x + 0.0001, distance);
        keep = select(keep, 1.0 - keep, effect.p0.y > 0.5);
        alpha *= keep;
      }
      case 84u: {
        let position = input.position.xy / max(effect.header.w, 2.0) + vec2f(effect.p0.y + effect_time * 0.04);
        var gradient = fractal_noise(position);
        gradient = mix(gradient, value_noise(position * 2.7), clamp((effect.p0.x - 1.0) / 4.0, 0.0, 1.0));
        gradient = select(gradient, 1.0 - gradient, effect.p0.z > 0.5);
        let keep = smoothstep(
          effect.header.y - effect.header.z,
          effect.header.y + effect.header.z + 0.0001,
          gradient,
        );
        alpha *= keep;
      }
      case 85u: {
        let center = effect.header.zw * resolution;
        let distance = length(input.position.xy - center);
        let maximum = max(length(resolution) * 0.5, 1.0);
        let noise_position = input.position.xy / max(effect.p0.x, 1.0) + vec2f(effect.p0.w + effect_time * 0.08);
        let burn_field = distance / maximum + (fractal_noise(noise_position) - 0.5) * 0.36;
        let edge = max(effect.p0.y / maximum, 0.0001);
        let hole = 1.0 - smoothstep(effect.header.y - edge, effect.header.y + edge, burn_field);
        let hot_edge = 1.0 - smoothstep(edge, edge * 3.0, abs(burn_field - effect.header.y));
        color += effect.p1.xyz * hot_edge * effect.p0.z;
        alpha *= 1.0 - hole;
        alpha = max(alpha, hot_edge * 0.75);
      }
      case 86u: {
        let pulse = step(fract(effect_time * max(effect.header.y, 0.1) + effect.header.w), effect.header.z);
        let amount = pulse * effect.p1.x;
        if effect.p0.x < 0.5 {
          color = mix(color, effect.p0.yzw, amount);
        } else if effect.p0.x < 1.5 {
          color += effect.p0.yzw * amount;
        } else {
          color = mix(color, color * effect.p0.yzw, amount);
        }
      }
      case 88u: {
        let base_direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let field = input.position.xy / max(effect.p0.x, 2.0);
        let jitter = (value_noise(field + vec2f(effect_time * 0.03)) - 0.5) * effect.header.w;
        let direction = rotate2(base_direction, jitter);
        let stroke = direction * effect.header.z / resolution;
        let painted = (
          textureSample(hdr_scene, linear_sampler, uv - stroke).rgb
          + textureSample(hdr_scene, linear_sampler, uv - stroke * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv).rgb
          + textureSample(hdr_scene, linear_sampler, uv + stroke * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv + stroke).rgb
        ) * 0.2;
        let levels = max(effect.p0.y, 2.0);
        let posterized = floor(clamp(painted, vec3f(0.0), vec3f(1.0)) * (levels - 1.0) + 0.5)
          / (levels - 1.0);
        color = mix(color, posterized, effect.p0.z);
      }
`;
