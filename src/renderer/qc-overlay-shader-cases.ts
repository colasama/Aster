export const qcOverlayPixelShaderCases = /* wgsl */ `
      case 259u: {
        let zebra_direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let zebra_coordinate = dot(input.position.xy, zebra_direction) / max(effect.header.z, 2.0);
        let zebra_stripe = step(0.5, fract(zebra_coordinate));
        let zebra_highlight = step(effect.header.y, luminance(color));
        let zebra_amount = zebra_stripe * zebra_highlight * effect.p0.w * effect.p1.x;
        color = mix(color, effect.p0.xyz, zebra_amount);
      }
      case 260u: {
        let gamut_level = luminance(color);
        let gamut_chroma = max(abs(color.r - gamut_level), max(abs(color.g - gamut_level), abs(color.b - gamut_level)));
        let gamut_scale = select(0.92, select(1.12, 2.0, effect.header.y > 1.5), effect.header.y > 0.5);
        let gamut_channel_violation = step(effect.header.z * gamut_scale, max(color.r, max(color.g, color.b)))
          + step(min(color.r, min(color.g, color.b)), -0.0001);
        let gamut_chroma_violation = step(effect.header.w * gamut_scale, gamut_chroma);
        let gamut_warning = clamp(gamut_channel_violation + gamut_chroma_violation, 0.0, 1.0);
        color = mix(color, effect.p0.xyz, gamut_warning * effect.p0.w * effect.p1.x);
      }
      case 261u: {
        let focus_offset = vec2f(effect.header.y) / resolution;
        let focus_horizontal = luminance(
          textureSample(hdr_scene, linear_sampler, uv + vec2f(focus_offset.x, 0.0)).rgb
        ) - luminance(
          textureSample(hdr_scene, linear_sampler, uv - vec2f(focus_offset.x, 0.0)).rgb
        );
        let focus_vertical = luminance(
          textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, focus_offset.y)).rgb
        ) - luminance(
          textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, focus_offset.y)).rgb
        );
        let focus_edge = smoothstep(effect.header.z, effect.header.z + 0.04, length(vec2f(focus_horizontal, focus_vertical)));
        let focus_color = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        color = mix(color, focus_color, focus_edge * effect.p0.z * effect.p0.w);
      }
      case 262u: {
        let boundary_range = sample_alpha_cross(uv, effect.header.y);
        let boundary_edge = smoothstep(
          effect.header.z,
          effect.header.z + 0.08,
          boundary_range.y - boundary_range.x,
        );
        let boundary_color = vec3f(effect.header.w, effect.p0.x, effect.p0.y);
        color = mix(color, boundary_color, boundary_edge * effect.p0.z * effect.p0.w);
      }
`;
