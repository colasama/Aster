
      case 266u: {
        let overscan_center = effect.header.zw;
        var overscan_uv = overscan_center + (uv - overscan_center) / max(effect.header.y, 0.01);
        if effect.p0.x > 0.5 {
          overscan_uv = abs(fract(overscan_uv * 0.5) * 2.0 - vec2f(1.0));
        }
        uv = mix(uv, overscan_uv, effect.p0.y);
      }
