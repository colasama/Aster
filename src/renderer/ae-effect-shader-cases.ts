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
      case 89u: {
        let source_luminance = luminance(color);
        let exposed_filter = effect.header.yzw * exp2(effect.p0.z);
        var filtered = mix(color, color * exposed_filter * 1.65, effect.p0.x);
        if effect.p0.y > 0.5 {
          filtered *= source_luminance / max(luminance(filtered), 0.0001);
        }
        color = max(filtered, vec3f(0.0));
      }
      case 90u: {
        let maximum = max(color.r, max(color.g, color.b));
        let minimum = min(color.r, min(color.g, color.b));
        var selection = max(color.r - max(color.g, color.b), 0.0);
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          selection = max(min(color.r, color.g) - color.b, 0.0);
        } else if effect.header.y > 1.5 && effect.header.y < 2.5 {
          selection = max(color.g - max(color.r, color.b), 0.0);
        } else if effect.header.y > 2.5 && effect.header.y < 3.5 {
          selection = max(min(color.g, color.b) - color.r, 0.0);
        } else if effect.header.y > 3.5 && effect.header.y < 4.5 {
          selection = max(color.b - max(color.r, color.g), 0.0);
        } else if effect.header.y > 4.5 && effect.header.y < 5.5 {
          selection = max(min(color.r, color.b) - color.g, 0.0);
        } else if effect.header.y > 5.5 && effect.header.y < 6.5 {
          selection = smoothstep(0.62, 0.95, minimum);
        } else if effect.header.y > 6.5 && effect.header.y < 7.5 {
          selection = (1.0 - clamp(maximum - minimum, 0.0, 1.0))
            * (1.0 - abs(clamp(luminance(color), 0.0, 1.0) - 0.5) * 2.0);
        } else if effect.header.y > 7.5 {
          selection = 1.0 - smoothstep(0.08, 0.38, maximum);
        }
        selection = clamp(selection * 2.4, 0.0, 1.0);
        let cmy_delta = vec3f(-effect.header.z, -effect.header.w, -effect.p0.x) - effect.p0.y;
        let adjustment = select(cmy_delta, cmy_delta * color, effect.p0.z > 0.5);
        color = max(color + adjustment * selection, vec3f(0.0));
      }
      case 91u: {
        let level = clamp(luminance(color), 0.0, 1.0);
        let shadow_weight = 1.0 - smoothstep(0.0, max(effect.header.w, 0.001), level);
        let highlight_weight = smoothstep(1.0 - max(effect.p0.x, 0.001), 1.0, level);
        var recovered = color + (vec3f(1.0) - color) * effect.header.y * shadow_weight;
        recovered -= recovered * effect.header.z * highlight_weight;
        recovered = (recovered - vec3f(0.5)) * (1.0 + effect.p0.z) + vec3f(0.5);
        let recovered_level = luminance(recovered);
        color = mix(vec3f(recovered_level), recovered, 1.0 + effect.p0.y * (shadow_weight + highlight_weight));
      }
      case 92u: {
        let channel_gain = vec3f(effect.p0.x, effect.p0.y, effect.p0.z);
        let graded = max((color + effect.header.z) * effect.header.w * channel_gain, vec3f(0.0));
        color = pow(graded, vec3f(1.0 / max(effect.header.y, 0.01)));
      }
      case 93u: {
        let exposed = color * exp2(effect.p0.x);
        let level = max(luminance(exposed), 0.0001);
        let excess = max(level - effect.header.z, 0.0);
        let compressed = effect.header.z + excess / max(effect.header.w, 1.0);
        let expanded = effect.header.z + excess * max(effect.header.w, 1.0);
        let mapped_level = select(compressed, expanded, effect.header.y > 0.5);
        let mapped = exposed * select(1.0, mapped_level / level, level > effect.header.z);
        color = mix(color, mapped, effect.p0.y);
      }
      case 94u: {
        let locale_limit = effect.header.z * select(0.94, 1.0, effect.header.y > 0.5);
        let level = luminance(color);
        let chroma = color - vec3f(level);
        let peak = max(color.r, max(color.g, color.b));
        let luminance_safe = color * min(1.0, locale_limit / max(peak, 0.0001));
        let chroma_peak = max(abs(chroma.r), max(abs(chroma.g), abs(chroma.b)));
        let saturation_scale = min(1.0, max(locale_limit - level, 0.0) / max(chroma_peak, 0.0001));
        let saturation_safe = vec3f(level) + chroma * saturation_scale;
        let safe = select(luminance_safe, saturation_safe, effect.header.w > 0.5);
        let violation = smoothstep(locale_limit - effect.p0.x, locale_limit + effect.p0.x + 0.0001, peak);
        color = mix(color, safe, violation * effect.p0.y);
      }
      case 95u: {
        let source_luminance = luminance(color);
        let balance = vec3f(
          1.0 + effect.header.y * 0.28 - effect.header.z * 0.04,
          1.0 + effect.header.z * 0.18,
          1.0 - effect.header.y * 0.28 - effect.header.z * 0.04,
        );
        var balanced = color * balance;
        if effect.p0.x > 0.5 {
          balanced *= source_luminance / max(luminance(balanced), 0.0001);
        }
        color = mix(color, balanced, effect.header.w);
      }
      case 96u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let offset = direction * effect.header.z / resolution;
        let forward = textureSample(hdr_scene, linear_sampler, uv + offset).rgb;
        let backward = textureSample(hdr_scene, linear_sampler, uv - offset).rgb;
        let detail = (backward - forward) * effect.header.w;
        let embossed = max(color + detail + vec3f(0.08), vec3f(0.0));
        color = mix(color, embossed, effect.p0.x);
      }
      case 97u: {
        color = (color - vec3f(0.5)) * effect.header.z + vec3f(0.5 + effect.header.y);
      }
      case 98u: {
        let exposed = max(color * exp2(effect.header.y) + effect.header.z, vec3f(0.0));
        color = pow(exposed, vec3f(1.0 / max(effect.header.w, 0.01)));
      }
      case 99u: {
        let gained = color * effect.header.w;
        let level = luminance(gained);
        let saturated = mix(vec3f(level), gained, effect.header.z);
        color = (saturated - vec3f(0.5)) * effect.header.y + vec3f(0.5);
      }
      case 100u: {
        let level = luminance(color);
        let chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        let adaptive = 1.0 + effect.header.y * (1.0 - clamp(chroma, 0.0, 1.0));
        color = mix(vec3f(level), color, effect.header.z * adaptive);
      }
      case 101u: {
        let blur_radius = effect.header.y * select(1.0, 0.72, effect.header.z > 0.5);
        color = sample_blur(uv, blur_radius);
      }
      case 102u: {
        let blurred_glow = sample_blur(uv, effect.header.z);
        let glow_level = luminance(blurred_glow);
        let highlight = max(glow_level - effect.header.y, 0.0) / max(glow_level, 0.0001);
        let generated = blurred_glow * highlight * effect.header.w;
        if effect.p0.x < 0.5 {
          color += generated;
        } else if effect.p0.x < 1.5 {
          color = generated + color * (1.0 - clamp(luminance(generated), 0.0, 1.0));
        } else {
          color = generated;
        }
      }
      case 103u: {
        let radial = pow(clamp(length(uv - vec2f(0.5)) * 1.414214, 0.0, 1.0), max(effect.header.w, 0.01));
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let offset = direction * effect.header.y * radial / resolution;
        color = vec3f(
          textureSample(hdr_scene, linear_sampler, uv + offset).r,
          color.g,
          textureSample(hdr_scene, linear_sampler, uv - offset).b,
        );
      }
      case 104u: {
        color *= exp2(effect.header.w);
        color *= vec3f(
          1.0 + effect.header.y * 0.16,
          1.0 + effect.header.z * 0.08,
          1.0 - effect.header.y * 0.16,
        );
        color += effect.p1.x;
        color = (color - vec3f(effect.p0.y)) * effect.p0.x + vec3f(effect.p0.y);
        color *= effect.p1.z;
        let level = luminance(color);
        let chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        let saturation = effect.p0.z * (1.0 + effect.p0.w * (1.0 - clamp(chroma, 0.0, 1.0)));
        color = mix(vec3f(level), color, saturation);
        color = pow(max(color, vec3f(0.0)), vec3f(1.0 / max(effect.p1.y, 0.01)));
        color = mix(color, vec3f(level * 0.75 + 0.08), effect.p1.w);
        let centered = uv * 2.0 - vec2f(1.0);
        let vignette = smoothstep(1.2, 0.18, dot(centered, centered));
        color *= mix(1.0 - effect.p2.x, 1.0, vignette);
        color += (hash(input.position.xy + vec2f(effect_time * 91.7)) - 0.5) * effect.p2.y;
        let bloom_sample = sample_blur(uv, max(effect.p2.z * 18.0, 0.5));
        let bloom_level = luminance(bloom_sample);
        color += bloom_sample * max(bloom_level - 0.68, 0.0) * effect.p2.z;
      }
      case 105u: {
        let strength = effect.header.z;
        let weave = vec2f(
          sin(effect_time * 17.0),
          cos(effect_time * 13.0),
        ) * effect.p0.y / resolution;
        let woven = textureSample(hdr_scene, linear_sampler, uv + weave).rgb;
        color = mix(color, woven, smoothstep(0.0, 0.25, effect.p0.y));
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          color *= vec3f(1.18, 1.03, 0.86);
          color = mix(vec3f(luminance(color)), color, 1.0 + 0.05 * strength);
        } else if effect.header.y > 1.5 && effect.header.y < 2.5 {
          color = (color - vec3f(0.45)) * (1.0 + 0.18 * strength) + vec3f(0.45);
          color = mix(vec3f(luminance(color)), color, 1.0 + 0.18 * strength);
        } else if effect.header.y > 2.5 {
          color = (color - vec3f(0.38)) * (1.0 + 0.24 * strength) + vec3f(0.38);
          color = mix(vec3f(luminance(color)), color, max(0.0, 1.0 - 0.35 * strength));
        } else {
          color = color / (color + vec3f(0.28 / max(strength, 0.05)));
        }
        color += (hash(input.position.yx + vec2f(effect_time * 127.0)) - 0.5) * effect.header.w * strength;
        let halation = sample_blur(uv, max(effect.p0.x * 28.0, 0.5));
        color += vec3f(halation.r, halation.g * 0.25, 0.0)
          * max(luminance(halation) - 0.72, 0.0) * effect.p0.x * strength;
      }
      case 108u: {
        let channel_values = array<f32, 7>(
          color.r,
          color.g,
          color.b,
          alpha,
          luminance(color),
          1.0,
          0.0,
        );
        let remapped = vec4f(
          channel_values[u32(clamp(effect.header.y, 0.0, 6.0))],
          channel_values[u32(clamp(effect.header.z, 0.0, 6.0))],
          channel_values[u32(clamp(effect.header.w, 0.0, 6.0))],
          channel_values[u32(clamp(effect.p0.x, 0.0, 6.0))],
        );
        color = remapped.rgb;
        alpha = remapped.a;
      }
      case 109u: {
        let original = color;
        let operand = effect.header.z;
        if effect.header.y < 0.5 {
          color += operand;
        } else if effect.header.y < 1.5 {
          color -= operand;
        } else if effect.header.y < 2.5 {
          color *= operand;
        } else if effect.header.y < 3.5 {
          let divisor = max(abs(operand), 0.0001) * select(-1.0, 1.0, operand >= 0.0);
          color /= divisor;
        } else if effect.header.y < 4.5 {
          color = vec3f(1.0) - (vec3f(1.0) - color) * (1.0 - operand);
        } else {
          color = abs(color - vec3f(operand));
        }
        color = mix(original, color, effect.p0.x);
        if effect.header.w > 0.5 {
          color = clamp(color, vec3f(0.0), vec3f(1.0));
        }
      }
      case 110u: {
        let input_range = max(effect.header.z - effect.header.y, 0.0001);
        var mapped_alpha = clamp((alpha - effect.header.y) / input_range, 0.0, 1.0);
        mapped_alpha = pow(mapped_alpha, 1.0 / max(effect.header.w, 0.01));
        mapped_alpha = mix(effect.p0.x, effect.p0.y, mapped_alpha);
        alpha = select(mapped_alpha, 1.0 - mapped_alpha, effect.p0.z > 0.5);
      }
      case 111u: {
        let source_luminance = luminance(color);
        let matte_color = effect.header.yzw;
        let edge_ratio = (1.0 - alpha) / max(alpha, 0.05);
        var corrected = max(color + (color - matte_color) * edge_ratio * effect.p0.x, vec3f(0.0));
        if effect.p0.y > 0.5 {
          corrected *= source_luminance / max(luminance(corrected), 0.0001);
        }
        color = corrected;
      }
      case 112u: {
        let distance = length(color - effect.header.yzw);
        let color_match = 1.0 - smoothstep(
          effect.p0.x,
          effect.p0.x + effect.p0.y + 0.0001,
          distance,
        );
        let matte = select(1.0 - color_match, color_match, effect.p0.z > 0.5);
        alpha *= matte;
      }
      case 113u: {
        let distance = length(color - effect.header.yzw);
        let color_match = 1.0 - smoothstep(
          effect.p0.x,
          effect.p0.x + effect.p0.w + 0.0001,
          distance,
        );
        let level = luminance(color);
        let lower = smoothstep(effect.p0.y - effect.p0.w, effect.p0.y + effect.p0.w + 0.0001, level);
        let upper = 1.0 - smoothstep(effect.p0.z - effect.p0.w, effect.p0.z + effect.p0.w + 0.0001, level);
        var matte = color_match * lower * upper;
        matte = select(matte, 1.0 - matte, effect.p1.x > 0.5);
        alpha *= matte;
      }
      case 114u: {
        let radius = abs(effect.header.y) * max(effect.p0.x, 1.0);
        let diagonal = select(0.7071068, 1.0, effect.header.w > 0.5);
        let offsets = array<vec2f, 8>(
          vec2f(1.0, 0.0),
          vec2f(-1.0, 0.0),
          vec2f(0.0, 1.0),
          vec2f(0.0, -1.0),
          vec2f(diagonal, diagonal),
          vec2f(-diagonal, diagonal),
          vec2f(diagonal, -diagonal),
          vec2f(-diagonal, -diagonal),
        );
        var neighborhood = alpha;
        for (var sample_index = 0u; sample_index < 8u; sample_index += 1u) {
          let sampled_alpha = textureSample(
            hdr_scene,
            linear_sampler,
            uv + offsets[sample_index] * radius / resolution,
          ).a;
          neighborhood = select(
            max(neighborhood, sampled_alpha),
            min(neighborhood, sampled_alpha),
            effect.header.y >= 0.0,
          );
        }
        let softness = clamp(effect.header.z / max(radius + effect.header.z, 0.0001), 0.0, 1.0);
        alpha = mix(neighborhood, alpha, softness);
      }
      case 115u: {
        let screen_color = effect.header.yzw;
        let source_luminance = luminance(color);
        let screen_luminance = luminance(screen_color);
        let source_chroma = color - vec3f(source_luminance);
        let screen_chroma = screen_color - vec3f(screen_luminance);
        let balance = mix(0.72, 1.28, effect.p0.y);
        let normalized_distance = length(source_chroma - screen_chroma)
          / max(length(screen_chroma) * effect.p0.x * balance, 0.0001);
        let screen_match = 1.0 - smoothstep(0.0, 1.0 + effect.p1.x, normalized_distance);
        let raw_matte = 1.0 - screen_match;
        let clipped_matte = clamp(
          (raw_matte - effect.p0.z) / max(effect.p0.w - effect.p0.z, 0.0001),
          0.0,
          1.0,
        );
        let screen_direction = normalize(screen_chroma + vec3f(0.0001));
        let spill = max(dot(source_chroma, screen_direction), 0.0);
        var despilled = max(
          color - screen_direction * spill * effect.p1.y * screen_match,
          vec3f(0.0),
        );
        despilled += source_luminance - luminance(despilled);
        color = mix(color, max(despilled, vec3f(0.0)), effect.p1.z);
        alpha *= mix(1.0, clipped_matte, effect.p1.z);
      }
`;
