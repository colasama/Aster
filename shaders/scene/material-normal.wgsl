
    var normal = safe_normalize3(input.normal, vec3f(0.0, 0.0, 1.0));
    if material_textures.normal_environment.z > 0.5 {
      let sampled_normal = textureSampleLevel(normal_texture, normal_sampler, input.uv, 0.0).xyz * 2.0 - 1.0;
      let scaled_sample = vec3f(
        sampled_normal.xy * material_textures.normal_environment.x,
        sampled_normal.z,
      );
      let tangent_space_normal = safe_normalize3(scaled_sample, vec3f(0.0, 0.0, 1.0));
      let projected_tangent = input.tangent.xyz - normal * dot(input.tangent.xyz, normal);
      var tangent = vec3f(1.0, 0.0, 0.0);
      if dot(projected_tangent, projected_tangent) > 0.00000001 {
        tangent = safe_normalize3(projected_tangent, tangent);
      } else {
        let fallback_axis = select(
          vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(normal.y) > 0.9
        );
        tangent = safe_normalize3(cross(fallback_axis, normal), tangent);
      }
      let handedness = select(-1.0, 1.0, input.tangent.w >= 0.0);
      let bitangent = safe_normalize3(cross(normal, tangent), vec3f(0.0, 1.0, 0.0)) * handedness;
      normal = safe_normalize3(
        tangent * tangent_space_normal.x
          + bitangent * tangent_space_normal.y
          + normal * tangent_space_normal.z,
        normal,
      );
    }
