      case 116u: {
        let blurred_red = sample_blur(uv, effect.header.y).r;
        let blurred_green = sample_blur(uv, effect.header.z).g;
        let blurred_blue = sample_blur(uv, effect.header.w).b;
        let alpha_offset = vec2f(max(effect.p0.x, 0.35)) / resolution;
        var blurred_alpha = textureSample(hdr_scene, linear_sampler, uv).a * 0.2;
        blurred_alpha += textureSample(hdr_scene, linear_sampler, uv + vec2f(alpha_offset.x, 0.0)).a * 0.2;
        blurred_alpha += textureSample(hdr_scene, linear_sampler, uv - vec2f(alpha_offset.x, 0.0)).a * 0.2;
        blurred_alpha += textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, alpha_offset.y)).a * 0.2;
        blurred_alpha += textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, alpha_offset.y)).a * 0.2;
        color = vec3f(blurred_red, blurred_green, blurred_blue);
        alpha = select(alpha, blurred_alpha, effect.p0.x > 0.001);
      }
      case 117u: {
        let horizontal_offset = vec2f(effect.header.y / resolution.x, 0.0);
        let vertical_offset = vec2f(0.0, effect.header.z / resolution.y);
        let horizontal = color * 0.4
          + textureSample(hdr_scene, linear_sampler, uv + horizontal_offset).rgb * 0.3
          + textureSample(hdr_scene, linear_sampler, uv - horizontal_offset).rgb * 0.3;
        let vertical = color * 0.4
          + textureSample(hdr_scene, linear_sampler, uv + vertical_offset).rgb * 0.3
          + textureSample(hdr_scene, linear_sampler, uv - vertical_offset).rgb * 0.3;
        color = mix(color, (horizontal + vertical) * 0.5, effect.header.w);
      }
      case 118u: {
        let original = color;
        let low_frequency = sample_blur(uv, effect.header.y);
        let detail = abs(luminance(original) - luminance(low_frequency));
        let edge = smoothstep(effect.header.z, effect.header.z + 0.04, detail);
        var result = mix(low_frequency, original, edge);
        if effect.header.w > 0.5 && effect.header.w < 1.5 {
          result = vec3f(edge);
        } else if effect.header.w > 1.5 {
          result = original + vec3f(edge) * 0.45;
        }
        color = mix(original, result, effect.p0.x);
      }
      case 119u: {
        let map_offset = vec2f(1.5) / resolution;
        let left_color = textureSample(hdr_scene, linear_sampler, uv - vec2f(map_offset.x, 0.0)).rgb;
        let right_color = textureSample(hdr_scene, linear_sampler, uv + vec2f(map_offset.x, 0.0)).rgb;
        let upper_color = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, map_offset.y)).rgb;
        let lower_color = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, map_offset.y)).rgb;
        var left = luminance(left_color);
        var right = luminance(right_color);
        var upper = luminance(upper_color);
        var lower = luminance(lower_color);
        if effect.header.w > 0.5 {
          let channel = u32(clamp(effect.header.w - 1.0, 0.0, 2.0));
          left = left_color[channel];
          right = right_color[channel];
          upper = upper_color[channel];
          lower = lower_color[channel];
        }
        let gradient = vec2f(right - left, lower - upper);
        let tangent = normalize(vec2f(-gradient.y, gradient.x) + vec2f(0.0001));
        let direction = rotate2(tangent, effect.header.z) * effect.header.y / resolution;
        let vector_blur = (
          textureSample(hdr_scene, linear_sampler, uv - direction).rgb
          + textureSample(hdr_scene, linear_sampler, uv - direction * 0.5).rgb
          + color
          + textureSample(hdr_scene, linear_sampler, uv + direction * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv + direction).rgb
        ) * 0.2;
        color = mix(color, vector_blur, effect.p0.x);
      }
      case 120u: {
        let center = effect.header.yz;
        let delta = uv - center;
        let amount = effect.header.w;
        var radial_blur = color;
        if effect.p0.x < 0.5 {
          radial_blur += textureSample(hdr_scene, linear_sampler, center + delta * (1.0 - amount)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + delta * (1.0 - amount * 0.5)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + delta * (1.0 + amount * 0.5)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + delta * (1.0 + amount)).rgb;
        } else {
          radial_blur += textureSample(hdr_scene, linear_sampler, center + rotate2(delta, -amount)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + rotate2(delta, -amount * 0.5)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + rotate2(delta, amount * 0.5)).rgb;
          radial_blur += textureSample(hdr_scene, linear_sampler, center + rotate2(delta, amount)).rgb;
        }
        color = mix(color, radial_blur * 0.2, effect.p0.y);
      }
      case 121u: {
        let original = color;
        let low_frequency = sample_blur(uv, effect.header.y);
        var detail = (original - low_frequency) * effect.header.z + vec3f(0.5);
        if effect.header.w > 0.5 {
          detail = vec3f(luminance(detail));
        }
        color = mix(original, detail, effect.p0.x);
      }
      case 122u: {
        let original = color;
        let edge_offset = vec2f(effect.header.z) / resolution;
        let neighbors =
          textureSample(hdr_scene, linear_sampler, uv + vec2f(edge_offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(edge_offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, edge_offset.y)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, edge_offset.y)).rgb;
        let laplacian = original * 4.0 - neighbors;
        let gate = smoothstep(effect.header.w, effect.header.w + 0.025, abs(luminance(laplacian)));
        let sharpened = max(original + laplacian * effect.header.y * gate, vec3f(0.0));
        color = mix(original, sharpened, effect.p0.x);
      }
      case 123u: {
        var map_value = luminance(color);
        if effect.header.z > 0.5 && effect.header.z < 1.5 {
          map_value = color.r;
        } else if effect.header.z > 1.5 && effect.header.z < 2.5 {
          map_value = color.g;
        } else if effect.header.z > 2.5 && effect.header.z < 3.5 {
          map_value = color.b;
        } else if effect.header.z > 3.5 {
          map_value = alpha;
        }
        map_value = select(map_value, 1.0 - map_value, effect.header.w > 0.5);
        let radius = effect.header.y * pow(clamp(map_value, 0.0, 1.0), max(effect.p0.x, 0.1));
        color = mix(color, sample_blur(uv, radius), effect.p0.y);
      }
      case 131u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let diagonal = length(resolution);
        let coordinate = dot((input.uv - vec2f(0.5)) * resolution, direction);
        let boundary = (effect.header.y - 0.5) * diagonal;
        let curl = clamp(
          (coordinate - boundary) / max(effect.header.w, 1.0),
          0.0,
          3.14159265,
        );
        let back_face = smoothstep(1.45, 1.72, curl) * (1.0 - smoothstep(3.0, 3.14159265, curl));
        let fold_shade = 0.7 + 0.3 * abs(cos(curl));
        color = mix(color * fold_shade, effect.p0.xyz * fold_shade, back_face * effect.p0.w);
      }
