
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
