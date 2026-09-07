export const aeDrawGeneratorPixelShaderCases = /* wgsl */ `
      case 267u: {
        let start = effect.header.yz;
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let direction = (vec2f(effect.header.w, effect.p0.x) - start) * aspect;
        let delta = (uv - start) * aspect;
        var coordinate = clamp(dot(delta, direction) / max(dot(direction, direction), 0.000001), 0.0, 1.0);
        if effect.p2.w > 1.5 {
          coordinate = fract((atan2(delta.y, delta.x) - atan2(direction.y, direction.x)) / 6.28318530718 + 1.0);
        } else if effect.p2.w > 0.5 {
          coordinate = clamp(length(delta) / max(length(direction), 0.000001), 0.0, 1.0);
        }
        let stops = array<f32, 5>(0.0, effect.p1.z, effect.p1.w, effect.p2.x, 1.0);
        let colors = array<f32, 5>(effect.p0.y, effect.p0.z, effect.p0.w, effect.p1.x, effect.p1.y);
        var gradient = vec3f(0.0);
        for (var index = 0u; index < 4u; index += 1u) {
          if coordinate >= stops[index] {
            let a = u32(colors[index]);
            let b = u32(colors[index + 1u]);
            let rgb_a = vec3f(f32((a >> 16u) & 255u), f32((a >> 8u) & 255u), f32(a & 255u)) / 255.0;
            let rgb_b = vec3f(f32((b >> 16u) & 255u), f32((b >> 8u) & 255u), f32(b & 255u)) / 255.0;
            let width = stops[index + 1u] - stops[index];
            let t = select(clamp((coordinate - stops[index]) / max(width, 0.000001), 0.0, 1.0), 1.0, width <= 0.0);
            gradient = mix(rgb_a, rgb_b, select(t, t * t * (3.0 - 2.0 * t), effect.p2.y > 0.5));
          }
        }
        let linear_gradient = select(gradient / 12.92, pow((gradient + vec3f(0.055)) / 1.055, vec3f(2.4)), gradient > vec3f(0.04045));
        color = mix(color, linear_gradient, effect.p2.z);
      }
      case 212u: {
        let ellipse_center = effect.header.yz * resolution;
        let ellipse_half_size = max(vec2f(effect.header.w, effect.p0.x) * 0.5, vec2f(0.5));
        let ellipse_local = rotate2(input.position.xy - ellipse_center, -effect.p0.y);
        let ellipse_distance = (length(ellipse_local / ellipse_half_size) - 1.0)
          * min(ellipse_half_size.x, ellipse_half_size.y);
        let ellipse_ring = 1.0 - smoothstep(
          effect.p0.z * 0.5,
          effect.p0.z * 0.5 + effect.p0.w + 0.0001,
          abs(ellipse_distance),
        );
        let ellipse_fill = 1.0 - smoothstep(0.0, effect.p0.w + 0.0001, ellipse_distance);
        let ellipse_shape = select(ellipse_ring, ellipse_fill, effect.p1.x > 0.5);
        let ellipse_amount = ellipse_shape * effect.p2.x * effect.p2.y;
        color = mix(color, effect.p1.yzw, ellipse_amount);
        alpha = max(alpha, ellipse_amount);
      }
      case 213u: {
        let stroke_start = effect.header.yz * resolution;
        let stroke_control = vec2f(effect.header.w, effect.p0.x) * resolution;
        let stroke_end = effect.p0.yz * resolution;
        var stroke_distance = 1000000.0;
        for (var stroke_index = 0u; stroke_index < 16u; stroke_index += 1u) {
          let stroke_segment_start = max(f32(stroke_index) / 16.0, effect.p1.y);
          let stroke_segment_end = min(f32(stroke_index + 1u) / 16.0, effect.p1.z);
          if stroke_segment_end >= stroke_segment_start {
            let stroke_inverse_a = 1.0 - stroke_segment_start;
            let stroke_inverse_b = 1.0 - stroke_segment_end;
            let stroke_point_a = stroke_inverse_a * stroke_inverse_a * stroke_start
              + 2.0 * stroke_inverse_a * stroke_segment_start * stroke_control
              + stroke_segment_start * stroke_segment_start * stroke_end;
            let stroke_point_b = stroke_inverse_b * stroke_inverse_b * stroke_start
              + 2.0 * stroke_inverse_b * stroke_segment_end * stroke_control
              + stroke_segment_end * stroke_segment_end * stroke_end;
            let stroke_segment = stroke_point_b - stroke_point_a;
            let stroke_projection = clamp(
              dot(input.position.xy - stroke_point_a, stroke_segment)
                / max(dot(stroke_segment, stroke_segment), 0.0001),
              0.0,
              1.0,
            );
            stroke_distance = min(
              stroke_distance,
              length(input.position.xy - (stroke_point_a + stroke_segment * stroke_projection)),
            );
          }
        }
        let stroke_shape = 1.0 - smoothstep(
          effect.p0.w * 0.5,
          effect.p0.w * 0.5 + effect.p1.x + 0.0001,
          stroke_distance,
        );
        let stroke_amount = stroke_shape * effect.p2.z * effect.p2.w;
        color = mix(color, vec3f(effect.p1.w, effect.p2.x, effect.p2.y), stroke_amount);
        alpha = max(alpha, stroke_amount);
      }
      case 214u: {
        let vegas_alpha_range = sample_alpha_cross(uv, effect.header.y);
        let vegas_edge = clamp(vegas_alpha_range.y - vegas_alpha_range.x, 0.0, 1.0);
        let vegas_coordinate = dot(input.position.xy, vec2f(0.70710678)) + effect.header.w * 32.0;
        let vegas_dash = step(0.42, fract(vegas_coordinate / max(effect.header.z, 2.0)));
        let vegas_stroke = smoothstep(0.0, max(effect.p0.x, 0.25) * 0.2, vegas_edge) * vegas_dash;
        let vegas_amount = vegas_stroke * effect.p1.x * effect.p1.y;
        color = mix(color, effect.p0.yzw, vegas_amount);
        alpha = max(alpha, vegas_amount);
      }
      case 215u: {
        let scribble_position = rotate2(input.position.xy, effect.header.z);
        let scribble_noise = (fractal_noise(
          scribble_position / max(effect.header.y, 2.0) + vec2f(effect.p0.y + effect_time * effect.p0.z),
        ) - 0.5) * effect.p0.x;
        let scribble_distance = abs(
          fract((scribble_position.y + scribble_noise) / max(effect.header.y, 2.0)) - 0.5
        ) * effect.header.y;
        let scribble_line = 1.0 - smoothstep(
          effect.header.w * 0.5,
          effect.header.w * 0.5 + 1.0,
          scribble_distance,
        );
        let scribble_amount = scribble_line * effect.p1.x * effect.p1.y * alpha;
        color = mix(color, effect.p0.yzw, scribble_amount);
      }
      case 216u: {
        let write_start = effect.header.yz * resolution;
        let write_end = mix(write_start, vec2f(effect.header.w, effect.p0.x) * resolution, effect.p0.y);
        let write_segment = write_end - write_start;
        let write_progress = clamp(
          dot(input.position.xy - write_start, write_segment) / max(dot(write_segment, write_segment), 0.0001),
          0.0,
          1.0,
        );
        let write_distance = length(input.position.xy - (write_start + write_segment * write_progress));
        let write_shape = 1.0 - smoothstep(
          effect.p0.z * 0.5,
          effect.p0.z * 0.5 + effect.p0.w + 0.0001,
          write_distance,
        );
        let write_amount = write_shape * effect.p1.w * effect.p2.x;
        color = mix(color, effect.p1.xyz, write_amount);
        alpha = max(alpha, write_amount);
      }
      case 217u: {
        let eyedrop_color = textureSample(hdr_scene, linear_sampler, effect.header.yz).rgb;
        let eyedrop_distance = length(color - eyedrop_color);
        let eyedrop_match = 1.0 - smoothstep(
          effect.header.w,
          effect.header.w + effect.p0.x + 0.0001,
          eyedrop_distance,
        );
        color = mix(color, effect.p0.yzw, eyedrop_match * effect.p1.x * effect.p1.y);
      }
      case 218u: {
        let bucket_seed = effect.header.yz;
        let bucket_color = textureSample(hdr_scene, linear_sampler, bucket_seed).rgb;
        let bucket_color_distance = length(color - bucket_color);
        let bucket_match = 1.0 - smoothstep(
          effect.header.w,
          effect.header.w + effect.p0.x + 0.0001,
          bucket_color_distance,
        );
        let bucket_spatial_distance = length((uv - bucket_seed) * resolution);
        let bucket_region = 1.0 - smoothstep(effect.p0.y * 0.82, effect.p0.y, bucket_spatial_distance);
        let bucket_amount = bucket_match * bucket_region * effect.p1.w * effect.p2.x;
        color = mix(color, effect.p1.xyz, bucket_amount);
      }
`;
