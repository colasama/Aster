
      case 268u: {
        let bokeh_mode = effect.header.z;
        let bokeh_sign = effect.header.w;
        let bokeh_focus = effect.p0.x;
        let bokeh_range = max(effect.p0.y, 0.0001);
        let bokeh_center = effect.p0.zw;
        let bokeh_blades = effect.p1.x;
        let bokeh_rotation = effect.p1.y;
        let bokeh_roundness = clamp(effect.p1.z, 0.0, 1.0);
        let bokeh_aspect = max(effect.p1.w, 0.05);
        let bokeh_gain = max(effect.p2.x, 0.0);
        let bokeh_threshold = effect.p2.y;
        let bokeh_saturation = clamp(effect.p2.z, 0.0, 1.0);
        let bokeh_samples = clamp(effect.p2.w, 8.0, 48.0);
        let bokeh_radius_max = max(effect.header.y, 0.0);
        let frame_aspect = resolution.x / max(resolution.y, 1.0);
        let center_depth = bokeh_field(
          bokeh_mode, uv, bokeh_center, frame_aspect, luminance(color),
        );
        let center_coc = bokeh_coc(
          center_depth, bokeh_focus, bokeh_range, bokeh_sign, bokeh_radius_max,
        );
        let bokeh_radius = abs(center_coc);
        if bokeh_radius >= 0.35 {
          let tap_lod = clamp(log2(bokeh_radius * 0.3), 0.0, max(settings.program.z, 0.0));
          var far_sum = vec4f(0.0);
          var far_weight = 0.0;
          var near_sum = vec4f(0.0);
          var near_weight = 0.0;
          let center_sample = vec4f(color * alpha, alpha);
          if center_coc >= 0.0 {
            far_sum = center_sample;
            far_weight = 1.0;
          } else {
            near_sum = center_sample;
            near_weight = 1.0;
          }
          for (var tap = 0u; tap < 48u; tap += 1u) {
            if f32(tap) >= bokeh_samples { break; }
            let offset = bokeh_disc_offset(
              tap, bokeh_samples, bokeh_blades, bokeh_rotation, bokeh_roundness, bokeh_aspect,
            ) * bokeh_radius;
            let sample_uv = uv + offset / resolution;
            let tap_sample = textureSampleLevel(blur_scene, linear_sampler, sample_uv, tap_lod);
            let tap_straight = tap_sample.rgb / max(tap_sample.a, 0.05);
            let tap_luminance = clamp(luminance(tap_straight), 0.0, 1.0);
            let tap_depth = bokeh_field(
              bokeh_mode, sample_uv, bokeh_center, frame_aspect, tap_luminance,
            );
            let tap_coc = bokeh_coc(
              tap_depth, bokeh_focus, bokeh_range, bokeh_sign, bokeh_radius_max,
            );
            let reach = clamp(abs(tap_coc) / max(length(offset), 0.5), 0.0, 1.0);
            let highlight_amount = smoothstep(
              bokeh_threshold, bokeh_threshold + 0.25, tap_luminance,
            );
            let tap_color = mix(
              tap_straight,
              mix(vec3f(tap_luminance), tap_straight, bokeh_saturation),
              highlight_amount,
            ) * (1.0 + max(tap_luminance - bokeh_threshold, 0.0) * bokeh_gain)
              * tap_sample.a;
            if tap_coc >= 0.0 {
              far_sum += vec4f(tap_color, tap_sample.a) * reach;
              far_weight += reach;
            } else {
              near_sum += vec4f(tap_color, tap_sample.a) * reach;
              near_weight += reach;
            }
          }
          var combined = far_sum / max(far_weight, 0.0001);
          let near_layer = near_sum / max(near_weight, 0.0001);
          combined = vec4f(
            near_layer.rgb + combined.rgb * (1.0 - near_layer.a),
            clamp(near_layer.a + combined.a * (1.0 - near_layer.a), 0.0, 1.0),
          );
          let bokeh_alpha = clamp(combined.a, 0.0, 1.0);
          let bokeh_color = select(
            vec3f(0.0),
            combined.rgb / max(combined.a, 0.0001),
            combined.a > 0.0001,
          );
          let fade = smoothstep(0.35, 1.5, bokeh_radius);
          color = mix(color, bokeh_color, fade);
          alpha = mix(alpha, bokeh_alpha, fade);
        }
      }
