
    if material_textures.normal_environment.y > 0.0 {
      let environment_intensity = material_textures.normal_environment.y;
      let environment_diffuse = sample_environment_cone(
        normal, 1.0, material_textures.normal_environment.w
      );
      let reflected = reflect(-view_direction, normal);
      let environment_specular = sample_environment_cone(
        reflected, roughness * roughness, material_textures.normal_environment.w
      );
      let diffuse_environment = color * (1.0 - metallic) * environment_diffuse;
      let specular_environment = mix(vec3f(0.04), color, metallic)
        * environment_specular;
      color += (diffuse_environment + specular_environment) * environment_intensity;
    }
