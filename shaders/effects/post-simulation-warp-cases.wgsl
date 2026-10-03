
      case 161u: {
        let tile_size = max(effect.header.z, 4.0);
        let cell = floor(input.position.xy / tile_size);
        let random_angle = hash(cell + vec2f(effect.p0.z)) * 6.283185;
        let random_distance = mix(0.35, 1.0, hash(cell + vec2f(effect.p0.z + 71.0)));
        let direction = vec2f(cos(random_angle), sin(random_angle));
        let progress = effect.header.y;
        let offset = direction * effect.header.w * random_distance * effect.p0.y * progress
          + vec2f(0.0, effect.p0.x * progress * progress);
        uv -= offset / resolution;
      }
      case 162u: {
        let grain = max(effect.header.w, 2.0);
        let cell = floor(input.position.xy / grain);
        let phase = effect.p0.y + time * 0.15;
        let random_offset = vec2f(
          hash(cell + vec2f(effect.p0.w + phase)) - 0.5,
          hash(cell + vec2f(effect.p0.w + phase + 83.0)) - 0.5,
        );
        let twisted = rotate2(random_offset, effect.p0.x);
        uv += twisted * effect.header.yz * effect.p0.z / resolution;
      }
