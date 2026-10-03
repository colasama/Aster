u); index++) {
      let extra = lighting.additional[index];
      let extra_to_light = extra.position_kind.xyz - input.world_position;
      let extra_distance = max(length(extra_to_light), 0.001);
      let extra_directional = extra.position_kind.w < 0.5;
      let extra_direction = select(
        safe_normalize3(extra_to_light, vec3f(0.0, 0.0, 1.0)),
        extra.direction_intensity.xyz,
        extra_directional,
      );
      let extra_normalized_distance = extra_distance / max(extra.range_cone.x, 1.0);
      var extra_attenuation = select(
        1.0 / (1.0 + extra_normalized_distance * extra_normalized_distance * 4.0),
        1.0, extra_directional,
      );
      if extra.position_kind.w > 1.5 {
        let extra_from_light = safe_normalize3(-extra_to_light, vec3f(0.0, 0.0, -1.0));
        extra_attenuation *= smoothstep(
          extra.range_cone.y, min(1.0, extra.range_cone.y + 0.08),
          dot(extra_from_light, extra.direction_intensity.xyz),
        );
      }
      let extra_radiance = extra.color_padding.rgb * extra.direction_intensity.w * extra_attenuation;
      let extra_half = safe_normalize3(extra_direction + view_direction, extra_direction);
      let extra_specular = fresnel * pow(max(dot(normal, extra_half), 0.0), specular_power);
      color += (input.color.rgb * (1.0 - metallic) * max(dot(normal, extra_direction), 0.0)
        + extra_specular) * extra_radiance;
    }
    