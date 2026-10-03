
      case 106u: {
        active_pixel_mask = effect_mask_value(effect, input.uv, resolution);
      }
      case 107u: {
        active_pixel_mask = 1.0;
      }
      default: {}
    }
    if code != 106u && code != 107u {
      color = mix(color_before_effect, color, active_pixel_mask);
      alpha = mix(alpha_before_effect, alpha, active_pixel_mask);
    }
  }

  let centered = uv * 2.0 - vec2f(1.0);
  let vignette = smoothstep(1.2, 0.18, dot(centered, centered));
  color *= mix(1.0 - settings.finish.x, 1.0, vignette);
  let noise = hash(input.position.xy + vec2f(effect_time * 91.7)) - 0.5;
  color += noise * settings.finish.y;
  if linear_output {
    return vec4f(max(color, vec3f(0.0)) * alpha, alpha);
  }
  return vec4f(linear_to_srgb(color) * alpha, alpha);
}
