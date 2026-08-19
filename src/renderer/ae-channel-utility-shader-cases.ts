export const aeChannelUtilityPixelShaderCases = /* wgsl */ `
      case 204u: {
        let shift_original_alpha = alpha;
        let shift_channels = array<f32, 7>(
          color.r,
          color.g,
          color.b,
          luminance(color),
          alpha,
          1.0,
          0.0,
        );
        var shift_alpha = shift_channels[u32(clamp(effect.header.y, 0.0, 6.0))];
        shift_alpha = select(shift_alpha, 1.0 - shift_alpha, effect.header.z > 0.5);
        alpha = mix(alpha, shift_alpha, effect.p0.x);
        if effect.header.w < 0.5 {
          color *= alpha / max(shift_original_alpha, 0.0001);
        }
      }
      case 205u: {
        let combine_original = color;
        if effect.header.y < 0.5 {
          let combine_luminance = luminance(color);
          color = vec3f(
            combine_luminance,
            (color.b - combine_luminance) * 0.5389 + 0.5,
            (color.r - combine_luminance) * 0.6350 + 0.5,
          );
        } else if effect.header.y < 1.5 {
          let combine_y = color.r;
          let combine_cb = color.g - 0.5;
          let combine_cr = color.b - 0.5;
          color = vec3f(
            combine_y + 1.5748 * combine_cr,
            combine_y - 0.1873 * combine_cb - 0.4681 * combine_cr,
            combine_y + 1.8556 * combine_cb,
          );
        } else {
          let combine_y = luminance(color);
          color = vec3f(combine_y, color.b - combine_y + 0.5, color.r - combine_y + 0.5);
        }
        color = mix(combine_original, color, effect.header.z);
      }
      case 206u: {
        let composite_background_alpha = effect.p0.x;
        let composite_output_alpha = alpha + composite_background_alpha * (1.0 - alpha);
        let composite_premultiplied = color * alpha
          + effect.header.yzw * composite_background_alpha * (1.0 - alpha);
        color = composite_premultiplied / max(composite_output_alpha, 0.0001);
        alpha = composite_output_alpha;
      }
      case 207u: {
        color = mix(color, color * alpha, effect.header.y);
      }
      case 208u: {
        let unpremultiplied = color / max(alpha, effect.header.y);
        color = mix(color, unpremultiplied, effect.header.z);
      }
      case 209u: {
        let luminance_range = max(effect.header.z - effect.header.y, 0.0001);
        var luminance_matte = clamp((luminance(color) - effect.header.y) / luminance_range, 0.0, 1.0);
        luminance_matte = pow(luminance_matte, 1.0 / max(effect.header.w, 0.01));
        luminance_matte = select(luminance_matte, 1.0 - luminance_matte, effect.p0.x > 0.5);
        var combined_matte = luminance_matte;
        if effect.p0.y > 0.5 && effect.p0.y < 1.5 {
          combined_matte *= alpha;
        } else if effect.p0.y > 1.5 {
          combined_matte = max(alpha, luminance_matte);
        }
        alpha = mix(alpha, combined_matte, effect.p0.z);
      }
      case 210u: {
        let matte_channels = array<f32, 7>(
          color.r,
          color.g,
          color.b,
          luminance(color),
          alpha,
          1.0,
          0.0,
        );
        let matte_value = matte_channels[u32(clamp(effect.header.y, 0.0, 6.0))];
        var selected_matte = smoothstep(
          effect.header.z - effect.header.w,
          effect.header.z + effect.header.w + 0.0001,
          matte_value,
        );
        selected_matte = select(selected_matte, 1.0 - selected_matte, effect.p0.x > 0.5);
        alpha = mix(alpha, selected_matte, effect.p0.y);
      }
      case 211u: {
        let clamp_original = color;
        let clamp_minimum = min(effect.header.y, effect.header.z);
        let clamp_maximum = max(effect.header.y, effect.header.z);
        let clamp_knee = max(effect.header.w, 0.0001);
        if effect.p0.x > 0.5 {
          let clamp_level = luminance(color);
          let hard_level = clamp(clamp_level, clamp_minimum, clamp_maximum);
          let interior = smoothstep(clamp_minimum - clamp_knee, clamp_minimum + clamp_knee, clamp_level)
            * (1.0 - smoothstep(clamp_maximum - clamp_knee, clamp_maximum + clamp_knee, clamp_level));
          let limited_level = mix(hard_level, clamp_level, interior);
          color *= limited_level / max(clamp_level, 0.0001);
        } else {
          let hard_color = clamp(color, vec3f(clamp_minimum), vec3f(clamp_maximum));
          let lower_interior = smoothstep(
            vec3f(clamp_minimum - clamp_knee),
            vec3f(clamp_minimum + clamp_knee),
            color,
          );
          let upper_interior = vec3f(1.0) - smoothstep(
            vec3f(clamp_maximum - clamp_knee),
            vec3f(clamp_maximum + clamp_knee),
            color,
          );
          color = mix(hard_color, color, lower_interior * upper_interior);
        }
        color = mix(clamp_original, color, effect.p0.y);
      }
`;
