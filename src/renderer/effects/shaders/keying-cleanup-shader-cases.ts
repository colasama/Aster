export const keyingCleanupPixelShaderCases = /* wgsl */ `
      case 235u: {
        let cleaner_range = sample_alpha_cross(uv, effect.header.y);
        let cleaner_average = (cleaner_range.x + cleaner_range.y) * 0.5;
        let cleaner_edge = clamp(cleaner_range.y - cleaner_range.x, 0.0, 1.0);
        let cleaner_stable = mix(alpha, cleaner_average, cleaner_edge * effect.p0.x);
        let cleaner_contrast = clamp((cleaner_stable - 0.5) * effect.header.w + 0.5, 0.0, 1.0);
        let cleaner_result = mix(cleaner_stable, cleaner_contrast, effect.header.z);
        alpha = mix(alpha, cleaner_result, effect.p0.y);
      }
      case 236u: {
        let screen_range = sample_alpha_cross(uv, abs(effect.p0.x) + effect.p0.y);
        let screen_morph = select(screen_range.x, screen_range.y, effect.p0.x >= 0.0);
        let screen_source = mix(alpha, screen_morph, clamp(abs(effect.p0.x), 0.0, 1.0));
        var screen_alpha = clamp(
          (screen_source - effect.header.y) / max(effect.header.z - effect.header.y, 0.0001),
          0.0,
          1.0,
        );
        screen_alpha = pow(screen_alpha, 1.0 / max(effect.header.w, 0.01));
        screen_alpha = select(screen_alpha, 1.0 - screen_alpha, effect.p0.z > 0.5);
        alpha = mix(alpha, screen_alpha, effect.p0.w);
      }
      case 237u: {
        let core_range = sample_alpha_cross(uv, effect.header.y);
        let core_selection = smoothstep(
          effect.header.z - effect.header.w,
          effect.header.z + effect.header.w + 0.0001,
          core_range.y,
        );
        let core_alpha = max(alpha, core_selection * effect.p0.x);
        alpha = mix(alpha, core_alpha, effect.p0.y);
      }
      case 238u: {
        let despot_range = sample_alpha_cross(uv, effect.header.y);
        var despot_result = alpha;
        if effect.header.w < 0.5 {
          let hole = (1.0 - step(effect.header.z, alpha)) * step(effect.header.z, despot_range.y);
          despot_result = mix(alpha, despot_range.y, hole * effect.p0.x);
        } else {
          let dot_mask = step(effect.header.z, alpha) * (1.0 - step(effect.header.z, despot_range.x));
          despot_result = mix(alpha, despot_range.x, dot_mask * effect.p0.x);
        }
        alpha = mix(alpha, despot_result, effect.p0.y);
      }
      case 239u: {
        let extend_offset = vec2f(effect.header.y) / resolution;
        let extend_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(extend_offset.x, 0.0));
        let extend_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(extend_offset.x, 0.0));
        let extend_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, extend_offset.y));
        let extend_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, extend_offset.y));
        let extend_weight = extend_a.a + extend_b.a + extend_c.a + extend_d.a;
        let extended_color = (
          extend_a.rgb * extend_a.a + extend_b.rgb * extend_b.a
            + extend_c.rgb * extend_c.a + extend_d.rgb * extend_d.a
        ) / max(extend_weight, 0.0001);
        let extend_edge = 1.0 - smoothstep(effect.header.w, effect.header.w + 0.08, alpha);
        color = mix(color, extended_color, extend_edge * effect.header.z * effect.p0.x);
      }
      case 240u: {
        let edge_blend_range = sample_alpha_cross(uv, effect.header.y);
        let edge_blend_mask = clamp(edge_blend_range.y - edge_blend_range.x, 0.0, 1.0);
        let edge_blur_color = sample_blur(uv, effect.header.y);
        var edge_blend_color = mix(color, edge_blur_color, effect.header.z);
        if effect.header.w > 0.5 {
          edge_blend_color *= luminance(color) / max(luminance(edge_blend_color), 0.0001);
        }
        color = mix(color, edge_blend_color, edge_blend_mask * effect.p0.x);
      }
      case 241u: {
        let spill_original = color;
        let spill_screen = normalize(max(effect.header.yzw, vec3f(0.0001)));
        let spill_level = luminance(color);
        let spill_projection = max(dot(color, spill_screen) - spill_level * effect.p0.y, 0.0);
        let spill_selection = smoothstep(effect.p0.z, effect.p0.z + 0.08, spill_projection);
        let spill_opposite = normalize(max(vec3f(1.0) - spill_screen, vec3f(0.0001)));
        var spill_result = color - spill_screen * spill_projection * effect.p0.x
          + spill_opposite * spill_projection * effect.p0.x * 0.35;
        if effect.p0.w > 0.5 {
          spill_result *= spill_level / max(luminance(spill_result), 0.0001);
        }
        color = mix(spill_original, max(spill_result, vec3f(0.0)), spill_selection * effect.p1.x);
      }
      case 242u: {
        let wire_start = effect.header.yz * resolution;
        let wire_end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let wire_segment = wire_end - wire_start;
        let wire_length_squared = max(dot(wire_segment, wire_segment), 0.0001);
        let wire_progress = clamp(
          dot(input.position.xy - wire_start, wire_segment) / wire_length_squared,
          0.0,
          1.0,
        );
        let wire_nearest = wire_start + wire_segment * wire_progress;
        let wire_distance = length(input.position.xy - wire_nearest);
        let wire_direction = normalize(wire_segment + vec2f(0.0001));
        let wire_normal = vec2f(-wire_direction.y, wire_direction.x);
        let wire_sample_offset = wire_normal * effect.p0.w / resolution;
        let wire_replacement = (
          textureSample(hdr_scene, linear_sampler, uv + wire_sample_offset).rgb
            + textureSample(hdr_scene, linear_sampler, uv - wire_sample_offset).rgb
        ) * 0.5;
        let wire_mask = 1.0 - smoothstep(
          effect.p0.y * 0.5,
          effect.p0.y * 0.5 + effect.p0.z + 0.0001,
          wire_distance,
        );
        color = mix(color, wire_replacement, wire_mask * effect.p1.x);
      }
`;
