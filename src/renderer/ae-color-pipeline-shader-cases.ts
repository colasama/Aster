export const aeColorPipelinePixelShaderCases = /* wgsl */ `
      case 227u: {
        let printer_original = color;
        let printer_points = effect.header.yzw + vec3f(effect.p0.x);
        color *= exp2(printer_points * effect.p0.y);
        color = mix(printer_original, color, effect.p0.z);
      }
      case 228u: {
        let hue_original = color;
        let hue_angle = rgb_hue(color);
        let hue_distance = abs(atan2(
          sin(hue_angle - effect.header.y),
          cos(hue_angle - effect.header.y),
        ));
        let hue_selection = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + effect.p0.x + 0.0001,
          hue_distance,
        );
        let hue_shifted = hue_rotate(color, effect.header.w);
        color = mix(hue_original, hue_shifted, hue_selection * effect.p0.y);
      }
      case 229u: {
        let saturation_original = color;
        let saturation_hue = rgb_hue(color);
        let saturation_distance = abs(atan2(
          sin(saturation_hue - effect.header.y),
          cos(saturation_hue - effect.header.y),
        ));
        let saturation_selection = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + effect.p0.x + 0.0001,
          saturation_distance,
        );
        let saturation_level = luminance(color);
        let saturation_color = mix(vec3f(saturation_level), color, effect.header.w);
        color = mix(saturation_original, saturation_color, saturation_selection * effect.p0.y);
      }
      case 230u: {
        let luma_original = color;
        let luma_level = luminance(color);
        let luma_shadow = 1.0 - smoothstep(0.0, max(effect.p0.x, 0.0001), luma_level);
        let luma_highlight = smoothstep(effect.p0.y, 1.0, luma_level);
        let luma_midtone = clamp(1.0 - luma_shadow - luma_highlight, 0.0, 1.0);
        let luma_saturation = effect.header.y * luma_shadow
          + effect.header.z * luma_midtone + effect.header.w * luma_highlight;
        let luma_result = mix(vec3f(luma_level), color, luma_saturation);
        color = mix(luma_original, luma_result, effect.p0.z);
      }
      case 231u: {
        let shadow_original = color;
        let shadow_level = luminance(color);
        let shadow_selection = 1.0 - smoothstep(
          effect.header.y - effect.header.z,
          effect.header.y + effect.header.z + 0.0001,
          shadow_level,
        );
        let shadow_result = mix(vec3f(shadow_level), color, effect.header.w);
        color = mix(shadow_original, shadow_result, shadow_selection * effect.p0.x);
      }
      case 232u: {
        let tint_original = color;
        let tint_level = luminance(color);
        let tint_selection = smoothstep(
          effect.header.y - effect.header.z,
          effect.header.y + effect.header.z + 0.0001,
          tint_level,
        );
        let tint_color = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        var tint_result = mix(color, color * tint_color, effect.p0.z);
        if effect.p0.w > 0.5 {
          tint_result *= tint_level / max(luminance(tint_result), 0.0001);
        }
        color = mix(tint_original, tint_result, tint_selection * effect.p1.x);
      }
      case 233u: {
        let tone_original = color;
        let tone_exposed = max(color * exp2(effect.header.z), vec3f(0.0));
        var tone_mapped = aces_tonemap(tone_exposed / max(effect.header.w, 0.1));
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          let hable_a = 0.15;
          let hable_b = 0.50;
          let hable_c = 0.10;
          let hable_d = 0.20;
          let hable_e = 0.02;
          let hable_f = 0.30;
          let hable_color = (
            tone_exposed * (hable_a * tone_exposed + hable_c * hable_b) + hable_d * hable_e
          ) / (
            tone_exposed * (hable_a * tone_exposed + hable_b) + hable_d * hable_f
          ) - hable_e / hable_f;
          let hable_white = (
            effect.header.w * (hable_a * effect.header.w + hable_c * hable_b) + hable_d * hable_e
          ) / (
            effect.header.w * (hable_a * effect.header.w + hable_b) + hable_d * hable_f
          ) - hable_e / hable_f;
          tone_mapped = hable_color / max(hable_white, 0.0001);
        } else if effect.header.y > 1.5 {
          tone_mapped = tone_exposed / (tone_exposed + vec3f(effect.header.w));
        }
        tone_mapped = pow(clamp(tone_mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / (1.0 + effect.p0.x)));
        tone_mapped = vec3f(1.0) - pow(vec3f(1.0) - tone_mapped, vec3f(1.0 + effect.p0.y));
        let tone_level = luminance(tone_mapped);
        tone_mapped = mix(vec3f(tone_level), tone_mapped, effect.p0.z);
        color = mix(tone_original, tone_mapped, effect.p0.w);
      }
      case 234u: {
        let skin_original = color;
        let skin_hue = rgb_hue(color);
        let skin_distance = abs(atan2(
          sin(skin_hue - effect.header.y),
          cos(skin_hue - effect.header.y),
        ));
        let skin_selection = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + effect.header.w + 0.0001,
          skin_distance,
        );
        let skin_level = luminance(color);
        var skin_result = mix(vec3f(skin_level), color, effect.p0.x);
        skin_result += vec3f(effect.p0.z, effect.p0.z * 0.35, -effect.p0.z * 0.45);
        skin_result += vec3f(effect.p0.y);
        color = mix(skin_original, max(skin_result, vec3f(0.0)), skin_selection * effect.p0.w);
      }
`;
