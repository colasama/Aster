export const aeRetroMediaWarpShaderCases = /* wgsl */ `
      case 255u: {
        let weave_phase = time * effect.p0.x + effect.p0.y;
        let weave_offset = vec2f(
          sin(weave_phase * 1.73) * effect.header.y,
          cos(weave_phase * 1.31) * effect.header.z,
        ) / resolution;
        let weave_rotation = sin(weave_phase) * effect.header.w;
        let woven_uv = rotate2(uv - vec2f(0.5), weave_rotation) + vec2f(0.5) + weave_offset;
        uv = mix(uv, woven_uv, effect.p0.z);
      }
`;

export const aeRetroMediaPixelShaderCases = /* wgsl */ `
      case 251u: {
        let scanline_position = fract(
          (input.position.y + effect.p0.x + effect_time * effect.p0.y) / max(effect.header.y, 1.0)
        ) * effect.header.y;
        let scanline_mask = 1.0 - smoothstep(
          effect.header.z,
          effect.header.z + 0.75,
          min(scanline_position, effect.header.y - scanline_position),
        );
        let scanline_color = color * (1.0 - scanline_mask * effect.header.w);
        color = mix(color, scanline_color, effect.p0.z);
      }
      case 252u: {
        let dropout_row = floor(input.position.y / max(effect.header.w, 1.0));
        let dropout_frame = floor(effect_time * effect.p0.x);
        let dropout_random = hash(vec2f(dropout_row + effect.p0.y, dropout_frame));
        let dropout_start = hash(vec2f(dropout_row, dropout_frame + 71.3)) * resolution.x;
        let dropout_region = step(dropout_random, effect.header.y)
          * step(dropout_start, input.position.x)
          * step(input.position.x, dropout_start + effect.header.z);
        let dropout_sample = textureSample(
          hdr_scene,
          linear_sampler,
          vec2f(fract(uv.x + 0.018), uv.y),
        ).rgb;
        color = mix(color, mix(vec3f(luminance(dropout_sample)), dropout_sample, 0.25), dropout_region * effect.p0.z);
      }
      case 253u: {
        let switching_boundary = 1.0 - effect.header.y
          + sin(effect_time * effect.header.w * 6.283185) * effect.header.y * 0.35;
        let switching_mask = smoothstep(
          switching_boundary - effect.p0.x,
          switching_boundary + effect.p0.x + 0.0001,
          uv.y,
        );
        let switching_offset = effect.header.z * switching_mask / resolution.x;
        let switching_color = textureSample(
          hdr_scene,
          linear_sampler,
          vec2f(fract(uv.x + switching_offset + 1.0), uv.y),
        ).rgb;
        color = mix(color, switching_color, switching_mask * effect.p0.y);
      }
      case 254u: {
        let compression_block = max(effect.header.y, 2.0);
        let compression_uv = (floor(input.position.xy / compression_block) + vec2f(0.5))
          * compression_block / resolution;
        let compression_sample = textureSample(hdr_scene, linear_sampler, compression_uv).rgb;
        let compression_levels = mix(8.0, 128.0, effect.header.z);
        let compression_quantized = floor(compression_sample * compression_levels + 0.5)
          / compression_levels;
        let compression_level = luminance(compression_quantized);
        var compression_color = mix(compression_quantized, vec3f(compression_level), effect.header.w);
        compression_color += (color - compression_sample) * effect.p0.x;
        color = mix(color, max(compression_color, vec3f(0.0)), effect.p0.y);
      }
      case 256u: {
        let damage_frame = floor(effect_time * effect.p0.x) + effect.p0.y;
        let scratch_column = hash(vec2f(floor(input.position.x / 2.0), damage_frame));
        let scratch = step(1.0 - effect.header.y * 0.08, scratch_column)
          * (0.5 + 0.5 * hash(vec2f(input.position.y, damage_frame)));
        let dust_cell = floor(input.position.xy / 18.0);
        let dust_random = hash(dust_cell + vec2f(damage_frame));
        let dust = step(1.0 - effect.header.z * 0.12, dust_random)
          * (1.0 - smoothstep(0.15, 0.5, length(fract(input.position.xy / 18.0) - vec2f(0.5))));
        let flicker = (hash(vec2f(damage_frame, 91.7)) - 0.5) * effect.header.w;
        let damaged = max(color * (1.0 + flicker) + vec3f(scratch * 0.55 - dust * 0.45), vec3f(0.0));
        color = mix(color, damaged, effect.p0.z);
      }
      case 257u: {
        let phosphor_pitch = max(effect.header.y, 1.0);
        let phosphor_channel = u32(floor(input.position.x / phosphor_pitch)) % 3u;
        var phosphor_mask = vec3f(1.0 - effect.header.z);
        if phosphor_channel == 0u {
          phosphor_mask.r = 1.0;
        } else if phosphor_channel == 1u {
          phosphor_mask.g = 1.0;
        } else {
          phosphor_mask.b = 1.0;
        }
        let phosphor_scanline = 1.0 - effect.header.w
          * (0.5 + 0.5 * cos(input.position.y * 3.14159265 / phosphor_pitch));
        let phosphor_offset = effect.p0.x / resolution.x;
        let phosphor_color = vec3f(
          textureSample(hdr_scene, linear_sampler, uv + vec2f(phosphor_offset, 0.0)).r,
          color.g,
          textureSample(hdr_scene, linear_sampler, uv - vec2f(phosphor_offset, 0.0)).b,
        ) * phosphor_mask * phosphor_scanline;
        color = mix(color, phosphor_color, effect.p0.y);
      }
      case 258u: {
        let sort_direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let sort_step = sort_direction * effect.header.z / 4.0 / resolution;
        var sort_samples = array<vec3f, 5>(
          textureSample(hdr_scene, linear_sampler, uv - sort_step * 2.0).rgb,
          textureSample(hdr_scene, linear_sampler, uv - sort_step).rgb,
          color,
          textureSample(hdr_scene, linear_sampler, uv + sort_step).rgb,
          textureSample(hdr_scene, linear_sampler, uv + sort_step * 2.0).rgb,
        );
        for (var sort_pass = 0u; sort_pass < 4u; sort_pass += 1u) {
          for (var sort_index = 0u; sort_index < (4u - sort_pass); sort_index += 1u) {
            let sort_a = luminance(sort_samples[sort_index]);
            let sort_b = luminance(sort_samples[sort_index + 1u]);
            let sort_swap = select((sort_a > sort_b), (sort_a < sort_b), effect.p0.x > 0.5);
            if sort_swap {
              let sort_temporary = sort_samples[sort_index];
              sort_samples[sort_index] = sort_samples[sort_index + 1u];
              sort_samples[sort_index + 1u] = sort_temporary;
            }
          }
        }
        let sort_selection = step(effect.header.y, luminance(color));
        color = mix(color, sort_samples[2], sort_selection * effect.p0.y);
      }
`;
