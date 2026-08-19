export const aeImmersiveVideoWarpShaderCases = /* wgsl */ `
      case 243u: {
        let sphere_longitude = (uv.x - 0.5) * 6.283185;
        let sphere_latitude = (0.5 - uv.y) * 3.14159265;
        var sphere_direction = vec3f(
          cos(sphere_latitude) * sin(sphere_longitude),
          sin(sphere_latitude),
          cos(sphere_latitude) * cos(sphere_longitude),
        );
        let sphere_pitch = rotate2(sphere_direction.yz, effect.header.z);
        sphere_direction = vec3f(sphere_direction.x, sphere_pitch.x, sphere_pitch.y);
        let sphere_yaw = rotate2(sphere_direction.xz, effect.header.y);
        sphere_direction = vec3f(sphere_yaw.x, sphere_direction.y, sphere_yaw.y);
        let sphere_roll = rotate2(sphere_direction.xy, effect.header.w);
        sphere_direction = vec3f(sphere_roll, sphere_direction.z);
        let rotated_longitude = atan2(sphere_direction.x, sphere_direction.z);
        let rotated_latitude = asin(clamp(sphere_direction.y, -1.0, 1.0));
        let sphere_uv = vec2f(
          fract(rotated_longitude / 6.283185 + 0.5),
          0.5 - rotated_latitude / 3.14159265,
        );
        uv = mix(uv, sphere_uv, effect.p0.x);
      }
      case 244u: {
        let plane_center = vec2f(effect.header.w, effect.p0.x);
        let plane_aspect = vec2f(resolution.x / resolution.y, 1.0);
        let plane_local = (uv - plane_center) * plane_aspect;
        let plane_radius = length(plane_local);
        let plane_angle = atan(plane_radius * tan(effect.header.y * 0.5))
          / max(effect.header.y * 0.5, 0.0001);
        let plane_projected = plane_center
          + plane_local * plane_angle / max(plane_radius, 0.0001) / plane_aspect;
        uv = mix(uv, mix(uv, plane_projected, effect.header.z), effect.p0.y);
      }
`;

export const aeImmersiveVideoPixelShaderCases = /* wgsl */ `
      case 245u: {
        let vr_polar = pow(max(cos((uv.y - 0.5) * 3.14159265), 0.0), effect.header.w);
        let vr_red_uv = vec2f(fract(uv.x + effect.header.y * vr_polar + 1.0), uv.y);
        let vr_blue_uv = vec2f(fract(uv.x + effect.header.z * vr_polar + 1.0), uv.y);
        let vr_chromatic = vec3f(
          textureSample(hdr_scene, linear_sampler, vr_red_uv).r,
          color.g,
          textureSample(hdr_scene, linear_sampler, vr_blue_uv).b,
        );
        color = mix(color, vr_chromatic, effect.p0.x);
      }
      case 246u: {
        let glitch_band = floor(input.position.y / max(effect.header.z, 2.0));
        let glitch_frame = floor(effect_time * effect.header.w);
        let glitch_random = hash(vec2f(glitch_band + effect.p0.y, glitch_frame));
        let glitch_offset = (glitch_random - 0.5) * effect.header.y / resolution.x;
        let glitch_split = effect.p0.x / resolution.x;
        let glitch_uv = vec2f(fract(uv.x + glitch_offset + 1.0), uv.y);
        let glitch_color = vec3f(
          textureSample(hdr_scene, linear_sampler, vec2f(fract(glitch_uv.x + glitch_split), uv.y)).r,
          textureSample(hdr_scene, linear_sampler, glitch_uv).g,
          textureSample(hdr_scene, linear_sampler, vec2f(fract(glitch_uv.x - glitch_split + 1.0), uv.y)).b,
        );
        color = mix(color, glitch_color, effect.p0.z);
      }
      case 247u: {
        let gradient_north = effect.header.yzw;
        let gradient_south = effect.p0.xyz;
        let gradient_coordinate = clamp(
          0.5 + (uv.y - 0.5) * cos(effect.p0.w) + (uv.x - 0.5) * sin(effect.p0.w),
          0.0,
          1.0,
        );
        let gradient_color = mix(gradient_north, gradient_south, gradient_coordinate);
        color = mix(color, color * gradient_color * 2.0, effect.p1.x * effect.p1.y);
      }
      case 248u: {
        let vr_glow_original = color;
        let vr_glow_blur = sample_blur(uv, effect.header.z);
        let vr_glow_level = luminance(vr_glow_blur);
        let vr_glow_highlight = max(vr_glow_level - effect.header.y, 0.0)
          / max(vr_glow_level, 0.0001);
        color = mix(vr_glow_original, color + vr_glow_blur * vr_glow_highlight * effect.header.w, effect.p0.x);
      }
      case 249u: {
        let vr_blur_horizontal = effect.header.y / resolution.x;
        let vr_blur_vertical = effect.header.z / resolution.y;
        let vr_blurred = (
          textureSample(hdr_scene, linear_sampler, vec2f(fract(uv.x + vr_blur_horizontal), uv.y)).rgb
            + textureSample(hdr_scene, linear_sampler, vec2f(fract(uv.x - vr_blur_horizontal + 1.0), uv.y)).rgb
            + textureSample(hdr_scene, linear_sampler, vec2f(uv.x, clamp(uv.y + vr_blur_vertical, 0.0, 1.0))).rgb
            + textureSample(hdr_scene, linear_sampler, vec2f(uv.x, clamp(uv.y - vr_blur_vertical, 0.0, 1.0))).rgb
        ) * 0.25;
        color = mix(color, vr_blurred, effect.header.w);
      }
      case 250u: {
        let noise_latitude = (uv.y - 0.5) * 3.14159265;
        let noise_position = vec2f(
          (uv.x - 0.5) * cos(noise_latitude),
          uv.y - 0.5,
        ) * effect.header.y + vec2f(effect_time * effect.header.z);
        var immersive_noise = fractal_noise(noise_position);
        immersive_noise = (immersive_noise - 0.5) * effect.header.w + 0.5 + effect.p0.x;
        let immersive_noise_color = vec3f(max(immersive_noise, 0.0));
        color = mix(color, immersive_noise_color, effect.p0.y * effect.p0.z);
      }
`;
