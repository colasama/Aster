
      case 255u: {
        let weave_phase = time * effect.p0.x + effect.p0.y;
        let weave_offset = vec2f(
          sin(weave_phase * 1.73) * effect.header.y,
          cos(weave_phase * 1.31) * effect.header.z,
        ) / resolution;
        let weave_rotation = sin(weave_phase) * effect.header.w;
        let woven_uv = rotate2(uv - vec2f(0.5), weave_rotation) + vec2f(0.5) + weave_offset;
        uv = mix(uv, woven_uv, effect.p0.z);
      }
