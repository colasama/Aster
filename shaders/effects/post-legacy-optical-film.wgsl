      case 101u: {
        let blur_radius = effect.header.y * select(1.0, 0.72, effect.header.z > 0.5);
        color = sample_blur(uv, blur_radius);
      }
      case 102u: {
        var generated: vec3f;
        if settings.program.w > 0.5 {
          // The masked chain already holds blur(bright-pass), so the halo
          // placement and falloff are exact rather than reconstructed.
          generated = sample_masked_blur(uv, effect.header.z) * effect.header.w;
        } else {
          let blurred_glow = sample_blur(uv, effect.header.z);
          let glow_level = luminance(blurred_glow);
          let highlight = max(glow_level - effect.header.y, 0.0) / max(glow_level, 0.0001);
          generated = blurred_glow * highlight * effect.header.w;
        }
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
