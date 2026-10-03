
    color += input.color.rgb * max(input.material.z, 0.0);
    let alpha_mode = input.gradient_style_parameters.x;
    let material_alpha = max(input.shape_style_color.a, 0.00001);
    let layer_opacity = clamp(input.color.a / material_alpha, 0.0, 1.0);
    if alpha_mode < 0.5 {
      alpha = layer_opacity;
    } else if alpha_mode < 1.5 {
      if input.shape_style_color.a < input.gradient_style_parameters.y { discard; }
      alpha = layer_opacity;
    }
  }
  return vec4f(color * alpha, alpha);
}
