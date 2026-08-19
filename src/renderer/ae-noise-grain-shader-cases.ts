export const aeNoiseGrainPixelShaderCases = /* wgsl */ `
      case 140u: {
        let grain_position = input.position.xy / max(effect.header.z, 0.25);
        let temporal_seed = floor(effect_time * effect.p1.x * 24.0);
        let hard_grain = hash(floor(grain_position) + vec2f(temporal_seed));
        let soft_grain = value_noise(grain_position + vec2f(temporal_seed));
        let mono_grain = mix(hard_grain, soft_grain, effect.header.w) - 0.5;
        let color_grain = vec3f(
          mono_grain,
          hash(floor(grain_position) + vec2f(temporal_seed + 31.7)) - 0.5,
          hash(floor(grain_position) + vec2f(temporal_seed + 83.1)) - 0.5,
        );
        let level = clamp(luminance(color), 0.0, 1.0);
        let shadow_weight = 1.0 - smoothstep(0.0, 0.5, level);
        let highlight_weight = smoothstep(0.5, 1.0, level);
        let midtone_weight = 1.0 - shadow_weight - highlight_weight;
        let tonal_amount = effect.p0.y * shadow_weight
          + effect.p0.z * midtone_weight
          + effect.p0.w * highlight_weight;
        let grain = mix(vec3f(mono_grain), color_grain, effect.p0.x);
        color += grain * effect.header.y * tonal_amount;
      }
      case 141u: {
        let original = color;
        let repaired = sample_blur(uv, effect.header.y);
        let difference = abs(luminance(original) - luminance(repaired));
        let defect = smoothstep(
          effect.header.z,
          effect.header.z + effect.header.w + 0.0001,
          difference,
        );
        color = mix(original, mix(original, repaired, defect), effect.p0.x);
      }
      case 142u: {
        let offset = vec2f(effect.header.y) / resolution;
        let sample_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb;
        let sample_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb;
        let sample_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb;
        let sample_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb;
        let median_color = vec3f(
          median5(color.r, sample_a.r, sample_b.r, sample_c.r, sample_d.r),
          median5(color.g, sample_a.g, sample_b.g, sample_c.g, sample_d.g),
          median5(color.b, sample_a.b, sample_b.b, sample_c.b, sample_d.b),
        );
        color = mix(color, median_color, effect.header.z);
      }
      case 143u: {
        let noise_position = floor(input.position.xy / max(effect.header.w, 0.25));
        let noise_value = hash(noise_position + vec2f(floor(effect.p0.x * effect_time * 24.0))) - 0.5;
        if effect.header.z < 0.5 {
          alpha += noise_value * effect.header.y;
        } else if effect.header.z < 1.5 {
          alpha *= 1.0 + noise_value * effect.header.y * 2.0;
        } else {
          alpha = mix(alpha, noise_value + 0.5, effect.header.y);
        }
        if effect.p0.y > 0.5 {
          alpha = clamp(alpha, 0.0, 1.0);
        }
      }
      case 144u: {
        let noise_position = floor(input.position.xy / max(effect.header.w, 0.25));
        let seed = vec2f(effect.p0.x);
        let hue_noise = (hash(noise_position + seed) - 0.5) * effect.header.y;
        let lightness_noise = (hash(noise_position + seed + vec2f(31.7)) - 0.5) * effect.header.z;
        let saturation_noise = (hash(noise_position + seed + vec2f(83.1)) - 0.5) * effect.header.w;
        let hue_amount = clamp(abs(hue_noise) / 3.14159265, 0.0, 1.0);
        let hue_shifted = select(
          mix(color, color.brg, hue_amount),
          mix(color, color.gbr, hue_amount),
          hue_noise >= 0.0,
        );
        let level = luminance(hue_shifted);
        color = mix(vec3f(level), hue_shifted, max(0.0, 1.0 + saturation_noise));
        color += lightness_noise;
      }
      case 145u: {
        let noise_position = floor(input.position.xy / max(effect.header.w, 0.25));
        let temporal_seed = floor(effect.p0.x * effect_time * 24.0) + effect.p0.y;
        let mono_noise = hash(noise_position + vec2f(temporal_seed)) - 0.5;
        let chroma_noise = vec3f(
          mono_noise,
          hash(noise_position + vec2f(temporal_seed + 37.0)) - 0.5,
          hash(noise_position + vec2f(temporal_seed + 91.0)) - 0.5,
        );
        color += mix(vec3f(mono_noise), chroma_noise, effect.header.z) * effect.header.y;
      }
      case 146u: {
        let original = color;
        let low_frequency = sample_blur(uv, effect.header.y);
        let detail = abs(luminance(original - low_frequency));
        let grain_weight = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + effect.header.w + 0.0001,
          detail,
        );
        color = mix(original, low_frequency, grain_weight * effect.p0.x);
      }
      case 147u: {
        let noise_position = input.position.xy / max(effect.header.w, 1.0)
          + vec2f(effect.p0.x + effect_time * 0.08);
        var turbulence = fractal_noise(noise_position);
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          turbulence = abs(turbulence * 2.0 - 1.0);
        } else if effect.header.y > 1.5 {
          turbulence = mix(turbulence, value_noise(noise_position * 3.2), 0.45);
        }
        turbulence = clamp((turbulence - 0.5) * effect.header.z + 0.5 + effect.header.w, 0.0, 1.0);
        let generated = vec3f(turbulence);
        var blended = generated;
        if effect.p0.z > 0.5 && effect.p0.z < 1.5 {
          blended = select(
            2.0 * color * generated,
            vec3f(1.0) - 2.0 * (vec3f(1.0) - color) * (vec3f(1.0) - generated),
            color >= vec3f(0.5),
          );
        } else if effect.p0.z > 1.5 && effect.p0.z < 2.5 {
          blended = color + generated;
        } else if effect.p0.z > 2.5 {
          blended = color * generated;
        }
        color = mix(color, blended, effect.p0.y);
      }
`;
