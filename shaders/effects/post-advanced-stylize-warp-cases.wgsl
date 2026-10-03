
      case 167u: {
        let grid = max(effect.header.yz, vec2f(1.0));
        let tiled = uv * grid + vec2f(effect.header.w, effect.p0.x);
        if effect.p0.y > 0.5 {
          uv = abs(fract(tiled * 0.5) * 2.0 - vec2f(1.0));
        } else {
          uv = fract(tiled);
        }
      }
