
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
