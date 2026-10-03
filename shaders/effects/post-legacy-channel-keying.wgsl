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
