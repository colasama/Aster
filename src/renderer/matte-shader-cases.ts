export const matteRefinePixelShaderCases = /* wgsl */ `
      case 172u: {
        let alpha_range = sample_alpha_cross(uv, effect.header.y);
        let shifted = mix(alpha_range.x, alpha_range.y, effect.header.z * 0.5 + 0.5);
        let contrasted = (shifted - 0.5) * effect.header.w + 0.5;
        let clipped = clamp(
          (contrasted - effect.p0.x) / max(effect.p0.y - effect.p0.x, 0.0001),
          0.0,
          1.0,
        );
        let edge = clamp(alpha_range.y - alpha_range.x, 0.0, 1.0);
        let level = luminance(color);
        color = mix(color, vec3f(level), edge * effect.p0.z * 0.28);
        alpha = clipped;
      }
      case 173u: {
        let alpha_range = sample_alpha_cross(uv, effect.header.y);
        let soft_alpha = mix(alpha, (alpha_range.x + alpha_range.y) * 0.5, effect.header.z);
        let shifted = clamp(soft_alpha + effect.header.w * 0.5, 0.0, 1.0);
        let refined = clamp((shifted - 0.5) * effect.p0.x + 0.5, 0.0, 1.0);
        let edge = clamp(alpha_range.y - alpha_range.x, 0.0, 1.0);
        color = mix(color, vec3f(luminance(color)), edge * effect.p0.y * 0.2);
        alpha = mix(alpha, refined, effect.p0.z);
      }
      case 174u: {
        let alpha_range = sample_alpha_cross(uv, effect.header.y);
        let expanded = mix(alpha_range.x, alpha_range.y, effect.header.z * 0.5 + 0.5);
        var feathered = pow(clamp((alpha + expanded) * 0.5, 0.0, 1.0), 1.0 / max(effect.header.w, 0.01));
        feathered *= effect.p0.x;
        alpha = select(feathered, 1.0 - feathered, effect.p0.y > 0.5);
      }
      case 175u: {
        let alpha_range = sample_alpha_cross(uv, effect.p0.x);
        var cleaned = clamp(
          (alpha - effect.header.y) / max(effect.header.z - effect.header.y, 0.0001),
          0.0,
          1.0,
        );
        cleaned = pow(cleaned, 1.0 / max(effect.header.w, 0.01));
        cleaned = mix(cleaned, (alpha_range.x + alpha_range.y) * 0.5, effect.p0.y);
        cleaned = max(cleaned, alpha_range.x * effect.p0.z);
        alpha = select(cleaned, 1.0 - cleaned, effect.p0.w > 0.5);
      }
      case 176u: {
        let alpha_range = sample_alpha_cross(uv, effect.p0.y);
        let edge = pow(clamp(alpha_range.y - alpha_range.x, 0.0, 1.0), effect.p0.z);
        let source_luminance = luminance(color);
        let contamination = effect.header.yzw;
        var corrected = max(
          color + (color - contamination) * (1.0 - alpha) / max(alpha, 0.08),
          vec3f(0.0),
        );
        if effect.p0.w > 0.5 {
          corrected *= source_luminance / max(luminance(corrected), 0.0001);
        }
        color = mix(color, corrected, edge * effect.p0.x);
      }
      case 177u: {
        let alpha_range = sample_alpha_cross(uv, effect.p0.x);
        let edge = pow(clamp(alpha - alpha_range.x, 0.0, 1.0), max(effect.p0.z, 0.01));
        let wrap = effect.header.yzw * effect.p0.y;
        var wrapped = vec3f(1.0) - (vec3f(1.0) - color) * (vec3f(1.0) - wrap);
        if effect.p0.w > 0.5 && effect.p0.w < 1.5 {
          wrapped = color + wrap;
        } else if effect.p0.w > 1.5 {
          wrapped = wrap;
        }
        color = mix(color, wrapped, edge * effect.p1.x);
      }
      case 178u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let offset = direction * effect.header.y / resolution;
        let forward = textureSample(hdr_scene, linear_sampler, uv + offset).a;
        let backward = textureSample(hdr_scene, linear_sampler, uv - offset).a;
        let height = (backward - forward) * effect.header.z;
        let highlight = max(height, 0.0) * effect.p0.w;
        let shadow = max(-height, 0.0) * effect.p1.w;
        color += effect.p0.xyz * highlight;
        color = mix(color, effect.p1.xyz, clamp(shadow, 0.0, 1.0));
      }
      case 179u: {
        let alpha_range = sample_alpha_cross(uv, effect.header.y * max(effect.p0.x, 1.0));
        let morphed = select(alpha_range.x, alpha_range.y, effect.header.z > 0.5);
        alpha = mix(morphed, alpha, effect.header.w);
      }
`;
