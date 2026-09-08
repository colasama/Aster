export const advancedTransitionWarpShaderCases = /* wgsl */ `
      case 153u: {
        let center = effect.header.zw;
        let scale = max(1.0 - effect.header.y, 0.001);
        let local = rotate2(uv - center, -effect.p0.x) / scale;
        uv = center + rotate2(local, effect.p0.x);
      }
      case 154u: {
        let center = effect.header.zw;
        let delta = (uv - center) * resolution;
        let distance = length(delta);
        let falloff = 1.0 - smoothstep(effect.p0.y, effect.p0.y + effect.p0.z, distance);
        let twist = effect.header.y * effect.p0.x * 6.283185 * falloff;
        uv = center + rotate2(delta, twist) / resolution;
      }
`;

export const advancedTransitionPixelShaderCases = /* wgsl */ `
      case 148u: {
        let direction = select(1.0, -1.0, effect.p0.x > 0.5);
        let angle = fract(
          (atan2(uv.y - 0.5, uv.x - 0.5) - effect.header.z) * direction / 6.283185 + 1.0,
        );
        let feather = max(effect.header.w / 6.283185, 0.00001);
        alpha *= smoothstep(effect.header.y - feather, effect.header.y + feather, angle);
      }
      case 149u: {
        let grid = max(effect.header.zw, vec2f(1.0));
        let cell_position = uv * grid;
        let cell = floor(cell_position);
        let random_order = hash(cell + vec2f(effect.p0.z));
        let cell_edge = min(
          min(fract(cell_position.x), 1.0 - fract(cell_position.x)),
          min(fract(cell_position.y), 1.0 - fract(cell_position.y)),
        );
        let border_keep = smoothstep(effect.p0.x * 0.5, effect.p0.x * 0.5 + 0.01, cell_edge);
        let keep = smoothstep(
          effect.header.y - effect.p0.y,
          effect.header.y + effect.p0.y + 0.0001,
          random_order,
        );
        alpha *= keep * border_keep;
      }
      case 150u: {
        let local = rotate2((uv - vec2f(0.5)) * resolution, -effect.header.z);
        let tooth_phase = fract((local.x / max(resolution.x, 1.0) + 0.5) * effect.header.w);
        let tooth = abs(tooth_phase * 2.0 - 1.0);
        let boundary = effect.header.y * resolution.y * 0.5
          * (1.0 + tooth * effect.p0.x);
        var keep = smoothstep(boundary - effect.p0.y, boundary + effect.p0.y + 0.0001, abs(local.y));
        keep = select(keep, 1.0 - keep, effect.p0.z > 0.5);
        alpha *= keep;
      }
      case 151u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let diagonal = length(resolution);
        let coordinate = dot((uv - vec2f(0.5)) * resolution, direction);
        let boundary = (effect.header.y - 0.5) * diagonal;
        let keep = smoothstep(boundary - effect.p1.x, boundary + effect.p1.x + 0.0001, coordinate);
        let light = exp(-abs(coordinate - boundary) / max(effect.header.w, 1.0));
        color += effect.p0.yzw * light * effect.p0.x;
        alpha = max(alpha * keep, light * 0.35);
      }
      case 152u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let diagonal = length(resolution);
        let coordinate = dot((uv - vec2f(0.5)) * resolution, direction);
        let boundary = (effect.header.y - 0.5) * diagonal;
        let transition = smoothstep(
          boundary - effect.p0.x - effect.header.w,
          boundary + effect.p0.x + effect.header.w,
          coordinate,
        );
        let keep = select(transition, 1.0 - transition, effect.p0.y > 0.5);
        alpha *= keep;
      }
      case 153u: {
        let center = effect.header.zw;
        let scale = max(1.0 - effect.header.y, 0.0);
        let local = abs(rotate2(input.uv - center, -effect.p0.x));
        let feather = effect.p0.y / max(resolution.x, resolution.y);
        let boundary = scale * 0.5;
        let keep_x = 1.0 - smoothstep(boundary - feather, boundary + feather + 0.0001, local.x);
        let keep_y = 1.0 - smoothstep(boundary - feather, boundary + feather + 0.0001, local.y);
        alpha *= keep_x * keep_y;
      }
      case 154u: {
        let center = effect.header.zw;
        let distance = length((input.uv - center) * resolution);
        let boundary = effect.header.y * effect.p0.y;
        alpha *= smoothstep(boundary - effect.p0.z, boundary + effect.p0.z + 0.0001, distance);
      }
      case 155u: {
        let grid = max(effect.header.zw, vec2f(1.0));
        let cell_position = input.uv * grid;
        let cell = floor(cell_position);
        let random_order = hash(cell + vec2f(effect.p0.y));
        let delay = random_order * effect.p0.x;
        let flip = clamp(
          (effect.header.y - delay) / max(1.0 - effect.p0.x, 0.05),
          0.0,
          1.0,
        );
        let flip_angle = flip * 3.14159265;
        let visibility = abs(cos(flip_angle));
        let back_face = step(1.5707963, flip_angle);
        let back_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, back_color, back_face * effect.p1.y);
        alpha *= visibility;
      }
`;
