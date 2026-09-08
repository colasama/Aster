export const simulationWarpShaderCases = /* wgsl */ `
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
`;

export const simulationPixelShaderCases = /* wgsl */ `
      case 156u: {
        let spacing = max(sqrt((resolution.x * resolution.y) / max(effect.header.y, 1.0)), 8.0);
        let animated = input.position.xy
          + vec2f(
            sin(input.position.y / spacing + effect_time * 2.0) * effect.p0.x,
            effect_time * effect.header.w,
          );
        let cell = floor(animated / spacing);
        let center = vec2f(
          hash(cell + vec2f(effect.p1.y)),
          hash(cell + vec2f(effect.p1.y + 47.0)),
        );
        let local = fract(animated / spacing) - center;
        let radius = effect.header.z * mix(0.55, 1.25, hash(cell + vec2f(effect.p1.y + 91.0)));
        let distance = length(local * spacing);
        let ring = 1.0 - smoothstep(1.0, 2.5, abs(distance - radius));
        let disk = 1.0 - smoothstep(radius, radius + 1.5, distance);
        let normal = local / max(length(local), 0.0001);
        let refracted = textureSample(
          hdr_scene,
          linear_sampler,
          uv - normal * disk * effect.p0.y * 3.0 / resolution,
        ).rgb;
        let bubble_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, refracted + bubble_color * ring * 0.85, max(disk * 0.35, ring));
        alpha = max(alpha, ring * 0.75);
      }
      case 157u: {
        let spacing = max(min(resolution.x, resolution.y) / max(effect.header.y, 0.1), 24.0);
        let cell = floor(input.position.xy / spacing);
        let center = (cell + vec2f(
          hash(cell + vec2f(effect.p1.y)),
          hash(cell + vec2f(effect.p1.y + 53.0)),
        )) * spacing;
        let phase = fract(effect_time * effect.p0.x / max(effect.header.z, 1.0)
          + hash(cell + vec2f(effect.p1.y + 97.0)));
        let radius = phase * effect.header.z;
        let distance = length(input.position.xy - center);
        let ring = 1.0 - smoothstep(
          effect.header.w,
          effect.header.w + 1.5,
          abs(distance - radius),
        );
        let ripple_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color += ripple_color * ring * effect.p0.y * (1.0 - phase);
        alpha = max(alpha, ring * (1.0 - phase));
      }
      case 158u: {
        let spacing = max(resolution.x / max(effect.header.y, 2.0), 2.0);
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let normal = vec2f(-direction.y, direction.x);
        let along = dot(input.position.xy, direction);
        let across = dot(input.position.xy, normal);
        let cell = floor(across / spacing);
        let root = (cell + 0.5) * spacing;
        let wave = sin(along / max(effect.header.z, 1.0) * 6.283185 + effect_time * effect.p0.z + cell)
          * effect.p0.y;
        let strand_distance = abs(across - root - wave);
        let strand_length = fract(along / max(effect.header.z, 1.0));
        let strand = (1.0 - smoothstep(effect.header.w, effect.header.w + 1.0, strand_distance))
          * step(strand_length, 0.92);
        let hair_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color += hair_color * strand * effect.p1.z;
        alpha = max(alpha, strand * effect.p1.z);
      }
      case 159u: {
        let producer = effect.header.yz * resolution;
        var field = 0.0;
        for (var blob_index = 0u; blob_index < 6u; blob_index += 1u) {
          let seed = f32(blob_index) * 37.1 + effect.p1.z;
          let age = fract(effect_time * 0.18 + hash(vec2f(seed)));
          let angle = hash(vec2f(seed + 19.0)) * 6.283185;
          let velocity = vec2f(cos(angle), sin(angle)) * effect.p0.x;
          let blob_position = producer + velocity * age
            + vec2f(0.0, effect.p0.y * age * age * 0.5);
          let size = effect.header.w * mix(0.6, 1.2, hash(vec2f(seed + 71.0)));
          field += exp(-pow(length(input.position.xy - blob_position) / max(size, 1.0), 2.0)
            * effect.p0.z);
        }
        let mercury = smoothstep(0.48, 0.72, field);
        let highlight = smoothstep(0.72, 1.2, field);
        let mercury_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color = mix(color, mercury_color * (0.55 + highlight * 1.4), mercury);
        alpha = max(alpha, mercury);
      }
      case 160u: {
        let producer = effect.header.yz * resolution;
        var particle_field = 0.0;
        for (var particle_index = 0u; particle_index < 8u; particle_index += 1u) {
          let seed = f32(particle_index) * 41.0 + effect.p2.y;
          let age = fract(effect_time / max(effect.p0.x, 0.1) + hash(vec2f(seed)));
          let spread_angle = (hash(vec2f(seed + 17.0)) - 0.5) * effect.p0.w;
          let direction = vec2f(cos(effect.p0.z + spread_angle), sin(effect.p0.z + spread_angle));
          let position = producer + direction * effect.p0.y * age
            + vec2f(0.0, effect.p1.x * age * age * 0.5);
          let radius = effect.p1.y * (1.0 - age * 0.55);
          particle_field += (1.0 - smoothstep(radius, radius + 1.5, length(input.position.xy - position)))
            * min(effect.header.w / 4.0, 1.5);
        }
        let particle_color = vec3f(effect.p1.z, effect.p1.w, effect.p2.x);
        color += particle_color * particle_field;
        alpha = max(alpha, clamp(particle_field, 0.0, 1.0));
      }
      case 161u: {
        let tile_size = max(effect.header.z, 4.0);
        let local = fract(input.position.xy / tile_size);
        let border = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
        let tile_keep = smoothstep(0.015, 0.06, border);
        let fade = 1.0 - smoothstep(1.0 - effect.p0.w, 1.0, effect.header.y);
        alpha *= tile_keep * fade;
      }
      case 163u: {
        let center = effect.header.yz * resolution;
        let distance = length(input.position.xy - center) / max(min(resolution.x, resolution.y), 1.0);
        let wave = sin(distance * effect.header.w * 6.283185 - effect_time * effect.p0.x * 6.283185)
          * exp(-distance * effect.p0.y) * effect.p0.z;
        let wave_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        let reflected = color * (1.0 + wave * 0.35) + wave_color * max(wave, 0.0);
        color = mix(color, reflected, effect.p1.z);
      }
`;
