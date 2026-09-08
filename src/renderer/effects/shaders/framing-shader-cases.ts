export const framingWarpShaderCases = /* wgsl */ `
      case 266u: {
        let overscan_center = effect.header.zw;
        var overscan_uv = overscan_center + (uv - overscan_center) / max(effect.header.y, 0.01);
        if effect.p0.x > 0.5 {
          overscan_uv = abs(fract(overscan_uv * 0.5) * 2.0 - vec2f(1.0));
        }
        uv = mix(uv, overscan_uv, effect.p0.y);
      }
`;

export const framingPixelShaderCases = /* wgsl */ `
      case 263u: {
        let crop_feather = effect.p0.y / resolution;
        let crop_horizontal = smoothstep(effect.header.y - crop_feather.x, effect.header.y + crop_feather.x, uv.x)
          * (1.0 - smoothstep(1.0 - effect.header.z - crop_feather.x, 1.0 - effect.header.z + crop_feather.x, uv.x));
        let crop_vertical = smoothstep(effect.header.w - crop_feather.y, effect.header.w + crop_feather.y, uv.y)
          * (1.0 - smoothstep(1.0 - effect.p0.x - crop_feather.y, 1.0 - effect.p0.x + crop_feather.y, uv.y));
        var crop_alpha = crop_horizontal * crop_vertical;
        crop_alpha = select(crop_alpha, 1.0 - crop_alpha, effect.p0.z > 0.5);
        alpha *= crop_alpha;
      }
      case 264u: {
        var letterbox_ratio = 2.39;
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          letterbox_ratio = 1.85;
        } else if effect.header.y > 1.5 && effect.header.y < 2.5 {
          letterbox_ratio = 1.0;
        } else if effect.header.y > 2.5 {
          letterbox_ratio = effect.header.z;
        }
        let composition_ratio = resolution.x / resolution.y;
        let visible_height = min(1.0, composition_ratio / max(letterbox_ratio, 0.01));
        let visible_width = min(1.0, letterbox_ratio / max(composition_ratio, 0.01));
        let letterbox_distance = max(
          abs(uv.x - 0.5) - visible_width * 0.5,
          abs(uv.y - 0.5) - visible_height * 0.5,
        );
        let letterbox_matte = smoothstep(
          -effect.p0.w / max(resolution.x, resolution.y),
          effect.p0.w / max(resolution.x, resolution.y) + 0.0001,
          letterbox_distance,
        );
        let letterbox_color = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        color = mix(color, letterbox_color, letterbox_matte * effect.p0.z * effect.p1.x);
      }
      case 265u: {
        let feather_width = effect.header.y / resolution;
        let rectangle_edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        let ellipse_edge = 1.0 - length((uv - vec2f(0.5)) * 2.0);
        let feather_edge = select(rectangle_edge, ellipse_edge, effect.header.z > 0.5);
        let feather_scale = select(feather_width.x, min(feather_width.x, feather_width.y), effect.header.z > 0.5);
        let feather_alpha = pow(
          smoothstep(0.0, max(feather_scale, 0.0001), feather_edge),
          effect.header.w,
        );
        alpha *= mix(1.0, feather_alpha, effect.p0.x);
      }
`;
