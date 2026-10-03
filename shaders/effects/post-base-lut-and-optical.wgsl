      case 32u: {
        let domain_min = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        let domain_max = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        let coordinate = clamp((color - domain_min) / max(domain_max - domain_min, vec3f(0.0001)), vec3f(0.0), vec3f(1.0));
        let graded = select(
          textureSampleLevel(lut_texture, lut_sampler, coordinate, 0.0).rgb,
          sample_lut_tetrahedral(coordinate),
          effect.header.z > 0.5,
        );
        color = mix(color, graded, effect.header.y);
      }
      case 33u: {
        let offset = vec2f(max(effect.header.y, 0.5)) / resolution;
        let center_level = luminance(color);
        var weighted = color;
        var total_weight = 1.0;
        let sample_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb;
        let sample_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb;
        let sample_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb;
        let sample_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb;
        let threshold = max(effect.header.z, 0.0001);
        let weight_a = exp(-abs(luminance(sample_a) - center_level) / threshold);
        let weight_b = exp(-abs(luminance(sample_b) - center_level) / threshold);
        let weight_c = exp(-abs(luminance(sample_c) - center_level) / threshold);
        let weight_d = exp(-abs(luminance(sample_d) - center_level) / threshold);
        weighted += sample_a * weight_a + sample_b * weight_b + sample_c * weight_c + sample_d * weight_d;
        total_weight += weight_a + weight_b + weight_c + weight_d;
        color = weighted / total_weight;
      }
      case 34u: {
        let offset = vec2f(effect.header.y * 180.0, effect.header.y * 90.0) / resolution;
        var echo_color = color;
        var echo_weight = 1.0;
        let echo_count = min(u32(effect.header.z), 8u);
        for (var echo_index = 1u; echo_index <= 8u; echo_index += 1u) {
          if (echo_index > echo_count) { break; }
          let weight = pow(effect.header.w, f32(echo_index));
          let sample_color = textureSample(hdr_scene, linear_sampler, uv + offset * f32(echo_index)).rgb;
          if effect.p0.x < 0.5 {
            echo_color += sample_color * weight;
          } else if effect.p0.x < 1.5 {
            echo_color = max(echo_color, sample_color * weight);
          } else if effect.p0.x < 2.5 {
            echo_color = vec3f(1.0) - (vec3f(1.0) - echo_color) * (vec3f(1.0) - sample_color * weight);
          } else {
            echo_color += sample_color * weight;
            echo_weight += weight;
          }
        }
        color = select(echo_color, echo_color / max(echo_weight, 0.0001), effect.p0.x > 2.5);
      }
      case 35u: {
        let trail_offset = vec2f(effect.header.z * 150.0, effect.header.z * 45.0) / resolution;
        var trail = color;
        var trail_weight = 1.0;
        let trail_count = min(u32(effect.header.y), 6u);
        for (var trail_index = 1u; trail_index <= 6u; trail_index += 1u) {
          if (trail_index > trail_count) { break; }
          let weight = pow(effect.header.w, f32(trail_index));
          trail += textureSample(hdr_scene, linear_sampler, uv + trail_offset * f32(trail_index) / 6.0).rgb * weight;
          trail_weight += weight;
        }
        color = trail / trail_weight;
      }
      case 36u: {
        let cell_size = max(5.0, 42.0 / max(effect.header.y, 0.1));
        let cell = floor(input.position.xy / cell_size);
        let random = hash(cell + vec2f(effect.p0.y));
        let life = fract(time / max(effect.header.z, 0.01) + random);
        let local = fract(input.position.xy / cell_size);
        let center = vec2f(hash(cell + vec2f(19.3)), hash(cell + vec2f(71.7)));
        let gravity_offset = vec2f(0.0, effect.p0.x * life * life * 0.2);
        let distance = length(local - center - gravity_offset);
        let particle = (1.0 - smoothstep(0.04, 0.16, distance)) * (1.0 - life) * min(effect.header.w, 4.0);
        color += vec3f(0.35, 0.65, 1.0) * particle;
        alpha = max(alpha, particle);
      }
      case 37u: {
        color = mix(color, effect.header.yzw, effect.p0.x);
      }
      case 38u: {
        var inverted = vec3f(1.0) - color;
        if effect.header.y > 0.5 && effect.header.y < 1.5 { inverted = vec3f(1.0 - color.r, color.g, color.b); }
        if effect.header.y > 1.5 && effect.header.y < 2.5 { inverted = vec3f(color.r, 1.0 - color.g, color.b); }
        if effect.header.y > 2.5 { inverted = vec3f(color.r, color.g, 1.0 - color.b); }
        color = mix(color, inverted, effect.header.z);
      }
      case 39u: {
        let value = smoothstep(effect.header.y - effect.header.z, effect.header.y + effect.header.z, luminance(color));
        color = vec3f(value);
      }
      case 40u: {
        let monochrome = hash(input.position.xy + vec2f(time * 113.0)) - 0.5;
        let colored = vec3f(
          monochrome,
          hash(input.position.yx + vec2f(time * 157.0, 19.0)) - 0.5,
          hash(input.position.xy + vec2f(47.0, time * 193.0)) - 0.5,
        );
        color += select(vec3f(monochrome), colored, effect.header.z > 0.5) * effect.header.y;
      }
      case 43u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let coordinate = dot(input.position.xy, direction);
        let stripe = fract(coordinate / max(effect.header.w, 1.0));
        let feather = effect.p0.x / max(effect.header.w, 1.0);
        alpha *= 1.0 - smoothstep(effect.header.y - feather, effect.header.y + feather, stripe);
      }
      case 44u: {
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let ramp = clamp(dot(uv - vec2f(0.5), direction) + 0.5, 0.0, 1.0);
        let gradient = mix(effect.header.yzw, effect.p0.yzw, ramp);
        color = mix(color, gradient, effect.p1.x);
      }
      case 45u: {
        let direction = vec2f(cos(effect.p0.y),sin(effect.p0.y));
        let shadow_uv = uv-direction*effect.p0.z/resolution;
        let field = style_alpha_field(shadow_uv,effect.p0.w,effect.p1.x,resolution);
        let result = style_under(color,alpha,effect.header.yzw,field*effect.p0.x);
        color = result.rgb;
        alpha = result.a;
      }
      case 46u: {
        let level = clamp(luminance(color), 0.0, 1.0);
        let lower = mix(effect.header.yzw, effect.p0.xyz, smoothstep(0.0, 0.5, level));
        let upper = mix(effect.p0.xyz, vec3f(effect.p0.w, effect.p1.x, effect.p1.y), smoothstep(0.5, 1.0, level));
        color = mix(color, select(lower, upper, level > 0.5), effect.p1.z);
      }
      case 48u: {
        let monochrome = dot(color, effect.header.yzw);
        let tinted = vec3f(monochrome) * effect.p0.yzw;
        color = select(vec3f(monochrome), tinted, effect.p0.x > 0.5);
      }
      case 49u: {
        let phase = fract(luminance(color) + effect.header.y / 6.283185);
        var palette = hue_color(phase * 6.283185);
        if effect.header.z > 0.5 && effect.header.z < 1.5 {
          palette = vec3f(
            smoothstep(0.0, 0.55, phase),
            smoothstep(0.18, 0.72, phase) * (1.0 - smoothstep(0.72, 1.0, phase)),
            smoothstep(0.72, 1.0, phase) * 0.35,
          );
        } else if effect.header.z > 1.5 {
          palette = mix(vec3f(0.01, 0.08, 0.22), vec3f(0.12, 0.9, 1.0), smoothstep(0.0, 1.0, phase));
        }
        palette = mix(vec3f(luminance(palette)), palette, effect.header.w);
        color = mix(color, palette, effect.p0.x);
      }
      case 50u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let normal = vec2f(-sin(effect.header.w), cos(effect.header.w));
        let distance = abs(dot((uv - center) * resolution, normal));
        let band = pow(clamp(1.0 - distance / max(effect.p0.x, 1.0), 0.0, 1.0), max(effect.p0.z, 0.1));
        color += effect.p1.xyz * band * effect.p0.y * effect.p0.w;
      }
      case 52u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let offset = direction * max(effect.header.z, 0.25) / resolution;
        let forward = textureSample(hdr_scene, linear_sampler, uv + offset).a;
        let backward = textureSample(hdr_scene, linear_sampler, uv - offset).a;
        let edge = (backward - forward) * effect.header.w;
        let beveled = color
          + effect.p0.yzw * max(edge, 0.0)
          - (vec3f(1.0) - effect.p1.xyz) * max(-edge, 0.0);
        color = mix(color, beveled, effect.p0.x);
      }
      case 53u: {
        let offset = vec2f(max(effect.header.y, 0.25)) / resolution;
        let left = luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let right = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb);
        let up = luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        let down = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb);
        let normal = normalize(vec3f((left - right) * effect.header.z, (up - down) * effect.header.z, 1.0));
        let light = normalize(vec3f(cos(effect.p0.x), sin(effect.p0.x), max(effect.p0.y, 0.05)));
        let refracted = textureSample(hdr_scene, linear_sampler, uv + normal.xy * effect.header.w / resolution).rgb;
        let diffuse = max(dot(normal, light), 0.0);
        let specular = pow(diffuse, 24.0) * 0.8;
        let glass = refracted * (0.42 + diffuse * 0.72) + vec3f(specular);
        color = mix(color, glass, effect.p0.z);
      }
      case 54u: {
        let offset = vec2f(1.0) / resolution;
        let horizontal = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let vertical = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        let levels = max(effect.header.z, 2.0);
        let posterized = floor(clamp(color, vec3f(0.0), vec3f(1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
        let ink = smoothstep(effect.header.y, effect.header.y + effect.header.w, length(vec2f(horizontal, vertical)));
        color = mix(color, posterized * (1.0 - ink), effect.p0.x);
      }
      case 55u: {
        let solarized = select(color, max(vec3f(0.0), vec3f(1.0) - color), color > vec3f(effect.header.y));
        color = mix(color, solarized, effect.header.z);
      }
      case 56u: {
        let radius = max(abs(effect.header.y) + effect.header.z, 0.25);
        let offset = vec2f(radius) / resolution;
        let alpha_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).a;
        let alpha_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).a;
        let alpha_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).a;
        let alpha_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).a;
        let contracted = min(alpha, min(min(alpha_a, alpha_b), min(alpha_c, alpha_d)));
        let expanded = max(alpha, max(max(alpha_a, alpha_b), max(alpha_c, alpha_d)));
        let matte = select(expanded, contracted, effect.header.y >= 0.0);
        let amount = abs(effect.header.y) / max(abs(effect.header.y) + effect.header.z, 0.0001);
        alpha = mix(alpha, matte, amount);
      }
      case 57u: {
        let offset = vec2f(max(effect.header.y, 0.0)) / resolution;
        color = (
          textureSample(hdr_scene, linear_sampler, uv).rgb
          + textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb
          + textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb
          + textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb
        ) * 0.2;
      }
      case 58u: {
        var lens_color = vec3f(0.0);
        var lens_weight = 0.0;
        for (var lens_index = 0u; lens_index < 8u; lens_index += 1u) {
          let angle = effect.header.z + f32(lens_index) * 0.785398;
          let sample_uv = uv + vec2f(cos(angle), sin(angle)) * effect.header.y / resolution;
          let lens_sample = textureSample(hdr_scene, linear_sampler, sample_uv).rgb;
          let highlight = 1.0 + max(luminance(lens_sample) - effect.header.w, 0.0) * effect.p0.x;
          lens_color += lens_sample * highlight;
          lens_weight += highlight;
        }
        color = lens_color / max(lens_weight, 0.0001);
      }
      case 59u: {
        let distance = length(color - effect.header.yzw);
        let selection = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        var replacement = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        if effect.p1.y > 0.5 {
          replacement *= luminance(color) / max(luminance(replacement), 0.0001);
        }
        color = mix(color, replacement, selection);
      }
      case 60u: {
        let distance = length(color - effect.header.yzw);
        let selection = 1.0 - smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        let isolated = mix(vec3f(luminance(color)), color, selection);
        color = mix(color, isolated, effect.p0.z);
      }
      case 61u: {
        let level = luminance(color);
        var matte = smoothstep(effect.header.y - effect.header.w, effect.header.y + effect.header.w, level);
        matte *= 1.0 - smoothstep(effect.header.z - effect.header.w, effect.header.z + effect.header.w, level);
        matte = select(matte, 1.0 - matte, effect.p0.x > 0.5);
        alpha *= matte;
      }
      case 62u: {
        let position = input.position.xy / max(effect.header.z, 1.0) + vec2f(effect.p0.x + time * 0.08);
        let roughness = fractal_noise(position);
        let direction = normalize(vec2f(
          value_noise(position + vec2f(17.0, 3.0)) - 0.5,
          value_noise(position + vec2f(5.0, 29.0)) - 0.5,
        ) + vec2f(0.0001));
        let rough_alpha = textureSample(
          hdr_scene,
          linear_sampler,
          uv + direction * (roughness - 0.5) * effect.header.y / resolution,
        ).a;
        let detail = clamp(effect.header.w / 5.0, 0.0, 1.0);
        let erosion = smoothstep(0.5 - effect.p0.y, 0.5 + effect.p0.y, roughness) * detail;
        alpha = mix(alpha, min(alpha, rough_alpha), erosion);
      }
      case 63u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let direction = normalize(uv - center + vec2f(0.0001));
        let ray = direction * effect.header.w / resolution;
        var burst = vec3f(0.0);
        for (var burst_index = 1u; burst_index <= 5u; burst_index += 1u) {
          burst += textureSample(hdr_scene, linear_sampler, uv - ray * f32(burst_index) * 0.2).rgb;
        }
        burst = max(burst * 0.2 - color * 0.35, vec3f(0.0));
        let burst_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color = mix(color, color + burst * burst_color * effect.p0.x, effect.p0.y);
      }
      case 64u: {
        let center = vec2f(effect.header.y, effect.header.z);
        let direction = normalize(uv - center + vec2f(0.0001));
        let shadow_uv = uv - direction * effect.header.w / resolution;
        let soft = vec2f(max(effect.p0.y, 0.5)) / resolution;
        var shadow_alpha = textureSample(hdr_scene, linear_sampler, shadow_uv).a * 0.4;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(soft.x, 0.0)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv + vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha += textureSample(hdr_scene, linear_sampler, shadow_uv - vec2f(0.0, soft.y)).a * 0.15;
        shadow_alpha *= effect.p0.x;
        let shadow_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        color += shadow_color * shadow_alpha * (1.0 - alpha);
        alpha = max(alpha, shadow_alpha);
      }
