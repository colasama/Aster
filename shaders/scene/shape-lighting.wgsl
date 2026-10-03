
    let to_light = lighting.position_kind.xyz - input.world_position;
    let distance_to_light = max(length(to_light), 0.001);
    let directional = lighting.position_kind.w < 0.5;
    let light_direction = select(
      safe_normalize3(to_light, vec3f(0.0, 0.0, 1.0)),
      safe_normalize3(lighting.direction_intensity.xyz, vec3f(0.0, 0.0, 1.0)),
      directional,
    );
    let normalized_distance = distance_to_light / max(lighting.range_cone.x, 1.0);
    var attenuation = select(1.0 / (1.0 + normalized_distance * normalized_distance * 4.0), 1.0, directional);
    if lighting.position_kind.w > 1.5 {
      let from_light = safe_normalize3(
        input.world_position - lighting.position_kind.xyz, vec3f(0.0, 0.0, -1.0)
      );
      let cone = dot(
        from_light,
        safe_normalize3(lighting.direction_intensity.xyz, vec3f(0.0, 0.0, 1.0)),
      );
      attenuation *= smoothstep(lighting.range_cone.y, min(1.0, lighting.range_cone.y + 0.08), cone);
    }
    let diffuse_weight = max(dot(normal, light_direction), 0.0);
    let view_direction = safe_normalize3(
      lighting.camera_position.xyz - input.world_position,
      vec3f(0.0, 0.0, -1.0),
    );
    let half_direction = safe_normalize3(light_direction + view_direction, light_direction);
    let roughness = clamp(input.material.y, 0.04, 1.0);
    let metallic = clamp(input.material.x, 0.0, 1.0);
    let specular_power = mix(160.0, 4.0, roughness);
    let fresnel = mix(vec3f(0.04), color, metallic);
    let specular = fresnel * pow(max(dot(normal, half_direction), 0.0), specular_power);
    let radiance = lighting.color_ambient.rgb * lighting.direction_intensity.w * attenuation;
    let shadow_coordinate = shadow_position(input.world_position);
    let shadow_uv = vec2f(shadow_coordinate.x * 0.5 + 0.5, 0.5 - shadow_coordinate.y * 0.5);
    let inside_shadow_map = all(shadow_uv >= vec2f(0.0)) && all(shadow_uv <= vec2f(1.0))
      && shadow_coordinate.z >= 0.0 && shadow_coordinate.z <= 1.0;
    var visibility = 1.0;
    if inside_shadow_map && lighting.position_kind.w != 1.0 && lighting.range_cone.z > 0.5 {
      let comparison = textureSampleCompareLevel(
        shadow_map,
        shadow_sampler,
        shadow_uv,
        shadow_coordinate.z - lighting.shadow_center_bias.w,
      );
      visibility = mix(0.32, 1.0, comparison);
    }
    let diffuse = color * (1.0 - metallic) * diffuse_weight * radiance * visibility;
    color = color * lighting.color_ambient.w + diffuse + specular * radiance * visibility;
    // Extra lights share this material pass; only the primary light samples a shadow map.
    for (var index = 0u; index < min(u32(lighting.camera_position.w), 