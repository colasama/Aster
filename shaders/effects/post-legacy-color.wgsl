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
