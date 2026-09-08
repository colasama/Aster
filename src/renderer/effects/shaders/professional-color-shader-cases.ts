export const professionalColorPixelShaderCases = /* wgsl */ `
      case 188u: {
        let cdl_original = color;
        let cdl_slope = effect.header.yzw;
        let cdl_offset = effect.p0.xyz;
        let cdl_power = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        var cdl_graded = pow(max(color * cdl_slope + cdl_offset, vec3f(0.0)), vec3f(1.0) / max(cdl_power, vec3f(0.01)));
        let cdl_level = luminance(cdl_graded);
        cdl_graded = mix(vec3f(cdl_level), cdl_graded, effect.p1.z);
        color = mix(cdl_original, cdl_graded, 1.0);
      }
      case 189u: {
        let lgg_lift = effect.header.yzw;
        let lgg_gamma = effect.p0.xyz;
        let lgg_gain = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color = pow(max(color + lgg_lift, vec3f(0.0)), vec3f(1.0) / max(lgg_gamma, vec3f(0.01)))
          * lgg_gain * effect.p1.z;
      }
      case 190u: {
        let wheel_level = luminance(color);
        let shadow_weight = 1.0 - smoothstep(0.0, max(effect.p0.w, 0.001), wheel_level);
        let highlight_weight = smoothstep(effect.p1.x, 1.0, wheel_level);
        let midtone_weight = clamp(1.0 - shadow_weight - highlight_weight, 0.0, 1.0);
        var wheel_color = color;
        wheel_color += (hue_color(effect.header.y) - vec3f(0.5)) * effect.header.z * shadow_weight;
        wheel_color += (hue_color(effect.header.w) - vec3f(0.5)) * effect.p0.x * midtone_weight;
        wheel_color += (hue_color(effect.p0.y) - vec3f(0.5)) * effect.p0.z * highlight_weight;
        let wheel_luminance = luminance(wheel_color);
        color = mix(vec3f(wheel_luminance), wheel_color, effect.p1.y);
      }
      case 191u: {
        let secondary_level = luminance(color);
        let secondary_chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        let secondary_direction = normalize(max(color, vec3f(0.0)) + vec3f(0.0001));
        let secondary_reference = normalize(hue_color(effect.header.y) + vec3f(0.0001));
        let secondary_distance = length(secondary_direction - secondary_reference);
        let secondary_limit = max(effect.header.z / 3.14159265, 0.001);
        let secondary_softness = max(effect.p0.w, 0.0001);
        let hue_key = 1.0 - smoothstep(
          secondary_limit,
          secondary_limit + secondary_softness,
          secondary_distance,
        );
        let saturation_key = smoothstep(
          effect.header.w - secondary_softness,
          effect.header.w + secondary_softness,
          secondary_chroma,
        ) * (1.0 - smoothstep(
          effect.p0.x - secondary_softness,
          effect.p0.x + secondary_softness,
          secondary_chroma,
        ));
        let luminance_key = smoothstep(
          effect.p0.y - secondary_softness,
          effect.p0.y + secondary_softness,
          secondary_level,
        ) * (1.0 - smoothstep(
          effect.p0.z - secondary_softness,
          effect.p0.z + secondary_softness,
          secondary_level,
        ));
        var qualification = hue_key * saturation_key * luminance_key;
        qualification = select(qualification, 1.0 - qualification, effect.p1.w > 0.5);
        let hue_axis = vec3f(0.57735027);
        let hue_cosine = cos(effect.p1.x);
        let hue_sine = sin(effect.p1.x);
        let hue_rotated = color * hue_cosine
          + cross(hue_axis, color) * hue_sine
          + hue_axis * dot(hue_axis, color) * (1.0 - hue_cosine);
        let rotated_level = luminance(hue_rotated);
        let secondary_corrected = mix(vec3f(rotated_level), hue_rotated, effect.p1.y)
          + vec3f(effect.p1.z);
        color = mix(color, secondary_corrected, qualification);
      }
      case 192u: {
        let recovery_original = color;
        let recovery_peak = max(color.r, max(color.g, color.b));
        let recovery_excess = max(recovery_peak - effect.header.y, 0.0);
        let recovery_level = effect.header.y
          + recovery_excess / (1.0 + recovery_excess * effect.header.w);
        var recovery_color = color * recovery_level / max(recovery_peak, 0.0001);
        let recovery_luminance = luminance(recovery_color);
        recovery_color = mix(vec3f(recovery_luminance), recovery_color, effect.p0.x);
        color = mix(recovery_original, recovery_color, effect.header.z * effect.p0.y);
      }
      case 193u: {
        let gamut_original = color;
        let gamut_level = luminance(color);
        let gamut_chroma = color - vec3f(gamut_level);
        let gamut_magnitude = max(abs(gamut_chroma.r), max(abs(gamut_chroma.g), abs(gamut_chroma.b)));
        let gamut_excess = max(gamut_magnitude - effect.header.y, 0.0);
        let gamut_compressed = effect.header.y + gamut_excess / (
          1.0 + pow(gamut_excess / max(effect.header.z, 0.0001), effect.header.w)
        );
        let gamut_scale = select(1.0, gamut_compressed / max(gamut_magnitude, 0.0001), gamut_excess > 0.0);
        var gamut_color = max(vec3f(gamut_level) + gamut_chroma * gamut_scale, vec3f(0.0));
        if effect.p0.x > 0.5 {
          gamut_color += vec3f(gamut_level - luminance(gamut_color));
        }
        color = mix(gamut_original, max(gamut_color, vec3f(0.0)), effect.p0.y);
      }
      case 194u: {
        let false_luminance = max(luminance(color), 0.000001);
        let exposure_position = clamp(
          log2(false_luminance / max(effect.header.z, 0.0001)) / (2.0 * max(effect.header.w, 0.1)) + 0.5,
          0.0,
          1.0,
        );
        let ire_position = clamp(false_luminance, 0.0, 1.0);
        let false_position = select(exposure_position, ire_position, effect.header.y > 0.5);
        var false_palette = vec3f(0.28, 0.0, 0.48);
        if false_position > 0.14 {
          false_palette = vec3f(0.0, 0.16, 0.95);
        }
        if false_position > 0.29 {
          false_palette = vec3f(0.0, 0.78, 0.38);
        }
        if false_position > 0.43 {
          false_palette = vec3f(0.46);
        }
        if false_position > 0.57 {
          false_palette = vec3f(0.95, 0.9, 0.05);
        }
        if false_position > 0.72 {
          false_palette = vec3f(1.0, 0.34, 0.02);
        }
        if false_position > 0.88 {
          false_palette = vec3f(0.96, 0.0, 0.04);
        }
        color = mix(color, false_palette, effect.p0.x);
      }
      case 195u: {
        let print_original = color;
        let print_density = vec3f(effect.header.y, effect.header.z, effect.header.w)
          + vec3f(effect.p0.x);
        var print_color = max(color * exp2(-print_density), vec3f(0.0));
        print_color = max((print_color - vec3f(0.5)) * effect.p0.y + vec3f(0.5), vec3f(0.0));
        print_color = vec3f(1.0) - exp(-print_color / max(effect.p0.z, 0.0001));
        color = mix(print_original, print_color, effect.p0.w);
      }
`;
