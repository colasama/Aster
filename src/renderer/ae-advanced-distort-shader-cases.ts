export const aeAdvancedDistortWarpShaderCases = /* wgsl */ `
      case 196u: {
        let bezier_position = uv * 2.0 - vec2f(1.0);
        let bezier_horizontal = mix(effect.header.w, effect.p0.x, uv.y)
          * (1.0 - bezier_position.x * bezier_position.x);
        let bezier_vertical = mix(effect.header.y, effect.header.z, uv.x)
          * (1.0 - bezier_position.y * bezier_position.y);
        uv += vec2f(bezier_horizontal, bezier_vertical) * effect.p0.y / resolution;
      }
      case 197u: {
        let flow_pixel = uv * resolution;
        let flow_knot_a = effect.header.yz * resolution;
        let flow_knot_b = effect.p0.xy * resolution;
        let flow_delta_a = flow_pixel - flow_knot_a;
        let flow_delta_b = flow_pixel - flow_knot_b;
        let flow_radius = max(effect.p0.w, 1.0);
        let flow_weight_a = exp(-length(flow_delta_a) / flow_radius);
        let flow_weight_b = exp(-length(flow_delta_b) / flow_radius);
        let flow_a = normalize(flow_delta_a + vec2f(0.0001)) * effect.header.w * flow_weight_a;
        let flow_b = normalize(flow_delta_b + vec2f(0.0001)) * effect.p0.z * flow_weight_b;
        uv -= (flow_a + flow_b) * effect.p1.x / resolution;
      }
      case 198u: {
        let grid_tile = max(effect.header.yz, vec2f(2.0));
        let grid_offset = effect.p0.yz;
        let grid_pixel = uv * resolution + grid_offset;
        let grid_cell = floor(grid_pixel / grid_tile);
        let grid_center = (grid_cell + vec2f(0.5)) * grid_tile;
        let grid_local = grid_pixel - grid_center;
        let grid_transformed = rotate2(grid_local, -effect.header.w) / max(effect.p0.x, 0.01);
        let grid_uv = (grid_center + grid_transformed - grid_offset) / resolution;
        uv = mix(uv, grid_uv, effect.p0.w);
      }
      case 199u: {
        let pin_upper_left = effect.header.yz;
        let pin_upper_right = vec2f(effect.header.w, effect.p0.x);
        let pin_lower_left = effect.p0.yz;
        let pin_lower_right = vec2f(effect.p0.w, effect.p1.x);
        let pin_vertical = pow(clamp(uv.y, 0.0, 1.0), max(effect.p1.y, 0.1));
        let pin_top = mix(pin_upper_left, pin_upper_right, uv.x);
        let pin_bottom = mix(pin_lower_left, pin_lower_right, uv.x);
        let pin_uv = mix(pin_top, pin_bottom, pin_vertical);
        uv = mix(uv, pin_uv, effect.p1.z);
      }
      case 200u: {
        let pulse_center = effect.header.yz * resolution;
        let pulse_delta = uv * resolution - pulse_center;
        let pulse_distance = length(pulse_delta);
        let pulse_width = max(effect.p0.x, 1.0);
        let pulse_envelope = exp(-abs(pulse_distance - effect.header.w) / pulse_width)
          * exp(-pulse_distance * effect.p1.x / max(effect.header.w, 1.0));
        let pulse_phase = (pulse_distance - effect.header.w) / pulse_width * 6.283185
          + time * effect.p0.z + effect.p0.w;
        let pulse_offset = normalize(pulse_delta + vec2f(0.0001))
          * sin(pulse_phase) * effect.p0.y * pulse_envelope;
        uv += pulse_offset * effect.p1.y / resolution;
      }
      case 201u: {
        let slant_amount = tan(clamp(effect.header.y, -1.45, 1.45));
        if effect.header.w < 0.5 {
          uv.x -= (uv.y - effect.header.z) * slant_amount * effect.p0.x;
        } else {
          uv.y -= (uv.x - effect.header.z) * slant_amount * effect.p0.x;
        }
      }
      case 202u: {
        let smear_from = effect.header.yz * resolution;
        let smear_to = vec2f(effect.header.w, effect.p0.x) * resolution;
        let smear_segment = smear_to - smear_from;
        let smear_length_squared = max(dot(smear_segment, smear_segment), 0.0001);
        let smear_progress = clamp(
          dot(uv * resolution - smear_from, smear_segment) / smear_length_squared,
          0.0,
          1.0,
        );
        let smear_nearest = smear_from + smear_segment * smear_progress;
        let smear_distance = length(uv * resolution - smear_nearest);
        let smear_radius = max(effect.p0.y, 1.0);
        let smear_feather = max(effect.p0.w, 0.0001);
        let smear_weight = 1.0 - smoothstep(
          max(smear_radius - smear_feather, 0.0),
          smear_radius + smear_feather,
          smear_distance,
        );
        uv -= smear_segment * effect.p0.z * smear_weight * effect.p1.x / resolution;
      }
      case 203u: {
        let split_center = effect.header.yz * resolution;
        let split_normal = vec2f(-sin(effect.header.w), cos(effect.header.w));
        let split_signed_distance = dot(uv * resolution - split_center, split_normal);
        let split_side = select(-1.0, 1.0, split_signed_distance >= 0.0);
        let split_weight = smoothstep(
          0.0,
          max(effect.p0.y, 0.0001),
          abs(split_signed_distance),
        );
        uv -= split_normal * effect.p0.x * split_side * split_weight * effect.p0.z / resolution;
      }
`;
