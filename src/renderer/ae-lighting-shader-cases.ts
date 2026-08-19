export const aeLightingPixelShaderCases = /* wgsl */ `
      case 180u: {
        let center = effect.header.yz;
        let ray = normalize(uv - center + vec2f(0.0001)) * effect.header.w / resolution;
        var accumulated = vec3f(0.0);
        for (var ray_index = 1u; ray_index <= 6u; ray_index += 1u) {
          let sample_color = textureSample(
            hdr_scene,
            linear_sampler,
            uv - ray * f32(ray_index) / 6.0,
          ).rgb;
          let brightness = luminance(sample_color);
          accumulated += sample_color
            * max(brightness - effect.p0.x, 0.0) / max(brightness, 0.0001);
        }
        let ray_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, color + accumulated / 6.0 * ray_color * effect.p0.y, effect.p1.y);
      }
      case 181u: {
        let source = effect.header.yz * resolution;
        let spot_target = vec2f(effect.header.w, effect.p0.x) * resolution;
        let axis = normalize(spot_target - source + vec2f(0.0001));
        let to_pixel = input.position.xy - source;
        let distance = length(to_pixel);
        let direction = normalize(to_pixel + vec2f(0.0001));
        let angle = acos(clamp(dot(axis, direction), -1.0, 1.0));
        let cone = 1.0 - smoothstep(effect.p0.y - effect.p0.z, effect.p0.y + effect.p0.z, angle);
        let distance_falloff = pow(1.0 / (1.0 + distance / max(length(resolution), 1.0)), effect.p0.w);
        let spot_color = effect.p1.yzw;
        color += spot_color * cone * distance_falloff * effect.p1.x;
      }
      case 182u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let coordinate = dot(uv - vec2f(0.5), direction);
        let turbulence = fractal_noise(
          uv * 3.2 + vec2f(effect.p2.x + effect_time * effect.p1.w),
        );
        let center = sin(effect_time * effect.p1.w + effect.p2.x) * 0.32;
        let leak = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + effect.header.w,
          abs(coordinate - center) + (turbulence - 0.5) * 0.28,
        );
        let leak_color = mix(effect.p0.yzw, effect.p1.xyz, clamp(leak * 1.3, 0.0, 1.0));
        color = mix(color, color + leak_color * leak * effect.p0.x, effect.p2.y);
      }
      case 183u: {
        let center = effect.header.yz * resolution;
        let delta = input.position.xy - center;
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let normal = vec2f(-direction.y, direction.x);
        let along = abs(dot(delta, direction));
        let across = abs(dot(delta, normal));
        let streak = exp(-along / max(effect.p0.x, 1.0))
          * exp(-across / max(effect.p0.y, 0.5));
        let halo = exp(-length(delta) / max(effect.p0.y * 10.0, 1.0));
        let axis = resolution * vec2f(0.5) - center;
        let ghost_a = exp(-length(input.position.xy - (center + axis * 0.72)) / max(effect.p0.y * 4.0, 1.0));
        let ghost_b = exp(-length(input.position.xy - (center + axis * 1.3)) / max(effect.p0.y * 2.5, 1.0));
        let flare = (streak + halo * 0.4 + (ghost_a + ghost_b) * effect.p0.w) * effect.p0.z;
        color += effect.p1.xyz * flare;
        alpha = max(alpha, clamp(flare, 0.0, 1.0));
      }
      case 184u: {
        let fog_position = (
          input.position.xy + vec2f(effect.p0.x, effect.p0.y) * effect_time
        ) / max(effect.header.z, 4.0);
        let fog_noise = fractal_noise(fog_position);
        let height_falloff = pow(clamp(1.0 - uv.y, 0.0, 1.0), effect.header.w);
        let fog = clamp((fog_noise - 0.3) * 1.45, 0.0, 1.0)
          * effect.header.y * height_falloff;
        let fog_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, fog_color, fog * effect.p1.y);
      }
      case 185u: {
        let position = input.position.xy / max(effect.header.y, 2.0);
        let phase = effect_time * effect.header.z;
        var caustic = sin(position.x * 3.1 + phase)
          + sin(position.y * 4.3 - phase * 1.2)
          + sin((position.x + position.y) * effect.header.w + phase * 0.7);
        caustic = pow(clamp(abs(caustic) / 3.0, 0.0, 1.0), max(0.2, 2.0 - effect.p0.y));
        let caustic_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, color + caustic_color * caustic * effect.p0.x, effect.p1.y);
      }
      case 186u: {
        let center = effect.header.yz;
        let step_vector = (uv - center) * effect.header.w / 6.0;
        var sample_uv = uv;
        var illumination = vec3f(0.0);
        var decay = 1.0;
        for (var god_ray_index = 0u; god_ray_index < 6u; god_ray_index += 1u) {
          sample_uv -= step_vector;
          let sample_color = textureSample(hdr_scene, linear_sampler, sample_uv).rgb;
          let brightness = luminance(sample_color);
          illumination += sample_color
            * max(brightness - effect.p0.z, 0.0) / max(brightness, 0.0001)
            * decay * effect.p0.y;
          decay *= effect.p0.x;
        }
        color += illumination * effect.p1.xyz * effect.p0.w;
      }
      case 187u: {
        let start = effect.header.yz * resolution;
        let end = vec2f(effect.header.w, effect.p0.x) * resolution;
        let segment = end - start;
        let progress = clamp(
          dot(input.position.xy - start, segment) / max(dot(segment, segment), 0.0001),
          0.0,
          1.0,
        );
        let distance = length(input.position.xy - (start + segment * progress));
        let pulse = 1.0 + sin(effect_time * effect.p1.y * 6.283185) * effect.p1.x;
        let core = 1.0 - smoothstep(effect.p0.y, effect.p0.y + 1.0, distance);
        let halo = 1.0 - smoothstep(effect.p0.y, effect.p0.y + effect.p0.z, distance);
        let laser_color = vec3f(effect.p1.z, effect.p1.w, effect.p2.x);
        let laser = (core * 1.8 + halo * 0.55) * effect.p0.w * pulse;
        color += laser_color * laser;
        alpha = max(alpha, clamp(laser, 0.0, 1.0));
      }
`;
