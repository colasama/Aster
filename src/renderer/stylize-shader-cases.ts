export const advancedStylizeWarpShaderCases = /* wgsl */ `
      case 167u: {
        let grid = max(effect.header.yz, vec2f(1.0));
        let tiled = uv * grid + vec2f(effect.header.w, effect.p0.x);
        if effect.p0.y > 0.5 {
          uv = abs(fract(tiled * 0.5) * 2.0 - vec2f(1.0));
        } else {
          uv = fract(tiled);
        }
      }
`;

export const advancedStylizePixelShaderCases = /* wgsl */ `
      case 164u: {
        let radius = max(effect.header.y, 1.0);
        let red_local = fract(rotate2(input.position.xy, effect.header.z) / radius) - vec2f(0.5);
        let green_local = fract(rotate2(input.position.xy, effect.header.w) / radius) - vec2f(0.5);
        let blue_local = fract(rotate2(input.position.xy, effect.p0.x) / radius) - vec2f(0.5);
        let red_dot = 1.0 - smoothstep(sqrt(clamp(1.0 - color.r, 0.0, 1.0)) * 0.5, 0.52, length(red_local));
        let green_dot = 1.0 - smoothstep(sqrt(clamp(1.0 - color.g, 0.0, 1.0)) * 0.5, 0.52, length(green_local));
        let blue_dot = 1.0 - smoothstep(sqrt(clamp(1.0 - color.b, 0.0, 1.0)) * 0.5, 0.52, length(blue_local));
        var halftone = vec3f(1.0) - vec3f(red_dot, green_dot, blue_dot);
        if effect.p0.y > 0.5 {
          let mono = luminance(halftone);
          halftone = vec3f(mono);
        }
        color = mix(color, halftone, effect.p0.z);
      }
      case 165u: {
        let edge_offset = vec2f(effect.header.y) / resolution;
        let horizontal = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(edge_offset.x, 0.0)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(edge_offset.x, 0.0)).rgb);
        let vertical = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, edge_offset.y)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, edge_offset.y)).rgb);
        let edge = smoothstep(effect.header.z, effect.header.z + 0.04, length(vec2f(horizontal, vertical)));
        let background = select(vec3f(0.0), vec3f(1.0), effect.p0.w > 0.5);
        let glowing = background + effect.p0.xyz * edge * effect.header.w;
        color = mix(color, glowing, effect.p1.x);
      }
      case 166u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let position = input.position.xy / max(effect.header.y, 2.0) + vec2f(effect.p0.y);
        let step_size = 1.0 / max(effect.header.y, 2.0);
        let forward = fractal_noise(position + direction * step_size);
        let backward = fractal_noise(position - direction * step_size);
        let relief = (backward - forward) * effect.header.z * effect.p0.x;
        let textured = max(color + relief, vec3f(0.0));
        color = mix(color, textured, effect.p0.z);
      }
      case 167u: {
        let grid = max(effect.header.yz, vec2f(1.0));
        let local = fract(input.uv * grid + vec2f(effect.header.w, effect.p0.x));
        let edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
        let grout = 1.0 - smoothstep(effect.p0.z * 0.5, effect.p0.z * 0.5 + 0.005, edge);
        let grout_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        color = mix(color, grout_color, grout);
      }
      case 168u: {
        var level = luminance(color);
        if effect.header.w > 0.5 && effect.header.w < 1.5 {
          level = max(color.r, max(color.g, color.b));
        } else if effect.header.w > 1.5 {
          level = alpha;
        }
        var thresholded = smoothstep(
          effect.header.y - effect.header.z,
          effect.header.y + effect.header.z + 0.0001,
          level,
        );
        thresholded = select(thresholded, 1.0 - thresholded, effect.p0.x > 0.5);
        color = mix(color, vec3f(thresholded), effect.p0.y);
      }
      case 169u: {
        let level = clamp(luminance(color) + effect.p1.z * 0.25, 0.0, 1.0);
        let shadow_color = effect.header.yzw;
        let midtone_color = effect.p0.xyz;
        let highlight_color = vec3f(effect.p0.w, effect.p1.x, effect.p1.y);
        let low_mix = smoothstep(0.0, 0.5, level);
        let high_mix = smoothstep(0.5, 1.0, level);
        let toned = mix(mix(shadow_color, midtone_color, low_mix), highlight_color, high_mix);
        color = mix(color, toned, effect.p1.w);
      }
      case 170u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let offset = direction * effect.header.y / resolution;
        let forward = luminance(textureSample(hdr_scene, linear_sampler, uv + offset).rgb);
        let backward = luminance(textureSample(hdr_scene, linear_sampler, uv - offset).rgb);
        let normal_height = (backward - forward) * effect.header.z;
        let diffuse = 0.45 + max(normal_height, 0.0);
        let specular = pow(clamp(normal_height + 0.5, 0.0, 1.0), 8.0) * effect.p0.x;
        let plastic_color = effect.p0.yzw;
        let plastic = color * plastic_color * diffuse + specular;
        color = mix(color, plastic, effect.p1.x);
      }
      case 171u: {
        let low_frequency = sample_blur(uv, effect.header.y);
        let field = luminance(low_frequency);
        let blob = smoothstep(effect.header.z - effect.header.w, effect.header.z + effect.header.w, field);
        let direction = vec2f(cos(effect.p0.x), sin(effect.p0.x));
        let offset = direction * max(effect.header.y * 0.35, 1.0) / resolution;
        let forward = luminance(sample_blur(uv + offset, effect.header.y));
        let backward = luminance(sample_blur(uv - offset, effect.header.y));
        let lighting = 0.45 + (backward - forward) * effect.p0.y;
        let blob_color = vec3f(effect.p0.z, effect.p0.w, effect.p1.x);
        let blobby = blob_color * max(lighting, 0.0) * blob;
        color = mix(color, blobby, effect.p1.y);
        alpha = max(alpha, blob * effect.p1.y);
      }
`;
