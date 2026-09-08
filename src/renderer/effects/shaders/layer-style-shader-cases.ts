export const layerStylePixelShaderCases = /* wgsl */ `
      case 132u: {
        let field = style_alpha_field(uv,effect.p0.y,effect.p0.z,resolution);
        let glow_alpha = pow(clamp(field,0.0,1.0),max(effect.p0.w,0.05))*effect.p0.x;
        let result = style_under(color,alpha,effect.header.yzw,glow_alpha);
        color = result.rgb;
        alpha = result.a;
      }
      case 133u: {
        let offset = vec2f(effect.p0.y) / resolution;
        var minimum_alpha = 1.0;
        minimum_alpha = min(minimum_alpha, textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).a);
        minimum_alpha = min(minimum_alpha, textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).a);
        minimum_alpha = min(minimum_alpha, textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).a);
        minimum_alpha = min(minimum_alpha, textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).a);
        var glow_field = clamp(alpha - minimum_alpha + effect.p0.z, 0.0, 1.0);
        if effect.p0.w > 0.5 {
          glow_field = alpha * (1.0 - minimum_alpha);
        }
        color += effect.header.yzw * glow_field * effect.p0.x;
      }
      case 134u: {
        let offset = vec2f(effect.p0.y) / resolution;
        var minimum_alpha = alpha;
        var maximum_alpha = alpha;
        let alpha_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).a;
        let alpha_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).a;
        let alpha_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).a;
        let alpha_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).a;
        minimum_alpha = min(minimum_alpha, min(min(alpha_a, alpha_b), min(alpha_c, alpha_d)));
        maximum_alpha = max(maximum_alpha, max(max(alpha_a, alpha_b), max(alpha_c, alpha_d)));
        var stroke_field = max(maximum_alpha - alpha, 0.0);
        if effect.p0.z > 0.5 && effect.p0.z < 1.5 {
          stroke_field = max(alpha - minimum_alpha, 0.0);
        } else if effect.p0.z > 1.5 {
          stroke_field = max(maximum_alpha - minimum_alpha, 0.0);
        }
        let stroke_alpha = stroke_field * effect.p0.x;
        color = mix(color, effect.header.yzw, clamp(stroke_alpha, 0.0, 1.0));
        alpha = max(alpha, stroke_alpha);
      }
      case 135u: {
        let direction = vec2f(cos(effect.p0.y), sin(effect.p0.y));
        let shadow_uv = uv - direction * effect.p0.z / resolution;
        let soft = vec2f(effect.p0.w) / resolution;
        var shifted_alpha = textureSample(hdr_scene, linear_sampler, shadow_uv).a * 0.4;
        shifted_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(soft.x, 0.0)).a * 0.15;
        shifted_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(soft.x, 0.0)).a * 0.15;
        shifted_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(0.0, soft.y)).a * 0.15;
        shifted_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(0.0, soft.y)).a * 0.15;
        let shadow_field = alpha * clamp(1.0 - shifted_alpha + effect.p1.x, 0.0, 1.0);
        color = mix(color, effect.header.yzw, shadow_field * effect.p0.x);
      }
      case 136u: {
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let offset = direction * effect.header.w / resolution;
        let forward_alpha = textureSample(hdr_scene, linear_sampler, uv + offset).a;
        let backward_alpha = textureSample(hdr_scene, linear_sampler, uv - offset).a;
        var height = (backward_alpha - forward_alpha) * effect.header.z;
        if effect.header.y > 0.5 && effect.header.y < 1.5 {
          height = -height * (1.0 - alpha);
        } else if effect.header.y > 1.5 && effect.header.y < 2.5 {
          height *= 1.0 - abs(alpha * 2.0 - 1.0);
        } else if effect.header.y > 2.5 {
          height *= -1.0;
        }
        let highlight = max(height, 0.0) * effect.p1.x;
        let shadow = max(-height, 0.0) * effect.p2.x;
        color += effect.p0.yzw * highlight;
        color = mix(color, effect.p1.yzw, clamp(shadow, 0.0, 1.0));
      }
      case 137u: {
        let direction = vec2f(cos(effect.p0.y), sin(effect.p0.y));
        let coordinate = dot(input.position.xy, direction) + effect.p0.z;
        var satin = sin(coordinate / max(effect.p0.w, 1.0) * 3.14159265) * 0.5 + 0.5;
        satin *= alpha * (1.0 - abs(alpha * 2.0 - 1.0));
        satin = select(satin, 1.0 - satin, effect.p1.x > 0.5);
        color = mix(color, effect.header.yzw, satin * effect.p0.x * alpha);
      }
      case 138u: {
        let overlay_color = effect.header.yzw;
        var blended = overlay_color;
        if effect.p0.y > 0.5 && effect.p0.y < 1.5 {
          blended = color * overlay_color;
        } else if effect.p0.y > 1.5 && effect.p0.y < 2.5 {
          blended = vec3f(1.0) - (vec3f(1.0) - color) * (vec3f(1.0) - overlay_color);
        } else if effect.p0.y > 2.5 {
          blended = select(
            2.0 * color * overlay_color,
            vec3f(1.0) - 2.0 * (vec3f(1.0) - color) * (vec3f(1.0) - overlay_color),
            color >= vec3f(0.5),
          );
        }
        color = mix(color, blended, effect.p0.x);
      }
      case 139u: {
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let scale = max(effect.p1.x, 0.01);
        let progress = clamp(dot(uv - vec2f(0.5), direction) / scale + 0.5, 0.0, 1.0);
        let gradient = mix(effect.header.yzw, effect.p0.yzw, progress);
        var blended = gradient;
        if effect.p1.z > 0.5 && effect.p1.z < 1.5 {
          blended = color * gradient;
        } else if effect.p1.z > 1.5 && effect.p1.z < 2.5 {
          blended = vec3f(1.0) - (vec3f(1.0) - color) * (vec3f(1.0) - gradient);
        } else if effect.p1.z > 2.5 {
          blended = select(
            2.0 * color * gradient,
            vec3f(1.0) - 2.0 * (vec3f(1.0) - color) * (vec3f(1.0) - gradient),
            color >= vec3f(0.5),
          );
        }
        color = mix(color, blended, effect.p1.y);
      }
`;
