export const aeDetailProcessingPixelShaderCases = /* wgsl */ `
      case 219u: {
        let upscale_original = color;
        let upscale_soft = sample_blur(uv, max(effect.header.y * 0.5, 0.5));
        let upscale_detail = color - upscale_soft;
        let upscale_gate = smoothstep(
          effect.header.w,
          effect.header.w + 0.02,
          luminance(abs(upscale_detail)),
        );
        color = mix(
          upscale_original,
          max(color + upscale_detail * effect.header.z * upscale_gate, vec3f(0.0)),
          effect.p0.x,
        );
      }
      case 220u: {
        let flicker_offset = vec2f(0.0, effect.header.y / resolution.y);
        let flicker_filtered = textureSample(hdr_scene, linear_sampler, uv - flicker_offset).rgb * 0.25
          + color * 0.5
          + textureSample(hdr_scene, linear_sampler, uv + flicker_offset).rgb * 0.25;
        color = mix(color, flicker_filtered, effect.header.z * effect.header.w);
      }
      case 221u: {
        let deband_original = color;
        let deband_soft = sample_blur(uv, effect.header.y);
        let deband_difference = abs(luminance(color) - luminance(deband_soft));
        let deband_mask = 1.0 - smoothstep(effect.header.z, effect.header.z + 0.01, deband_difference);
        let deband_dither = (hash(input.position.xy + vec2f(effect_time * 23.17)) - 0.5)
          * effect.header.w / 255.0;
        let debanded = mix(color, deband_soft, deband_mask) + vec3f(deband_dither);
        color = mix(deband_original, max(debanded, vec3f(0.0)), effect.p0.x);
      }
      case 222u: {
        let denoise_original = color;
        let denoise_offset = vec2f(effect.header.y) / resolution;
        let denoise_luminance = luminance(color);
        let denoise_a = textureSample(hdr_scene, linear_sampler, uv + vec2f(denoise_offset.x, 0.0)).rgb;
        let denoise_b = textureSample(hdr_scene, linear_sampler, uv - vec2f(denoise_offset.x, 0.0)).rgb;
        let denoise_c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, denoise_offset.y)).rgb;
        let denoise_d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, denoise_offset.y)).rgb;
        let denoise_threshold = max(effect.header.z, 0.0001);
        let denoise_weights = vec4f(
          exp(-abs(luminance(denoise_a) - denoise_luminance) / denoise_threshold),
          exp(-abs(luminance(denoise_b) - denoise_luminance) / denoise_threshold),
          exp(-abs(luminance(denoise_c) - denoise_luminance) / denoise_threshold),
          exp(-abs(luminance(denoise_d) - denoise_luminance) / denoise_threshold),
        );
        let denoise_weight_sum = 1.0 + dot(denoise_weights, vec4f(1.0));
        let denoise_filtered = (
          color + denoise_a * denoise_weights.x + denoise_b * denoise_weights.y
            + denoise_c * denoise_weights.z + denoise_d * denoise_weights.w
        ) / denoise_weight_sum;
        let denoise_detail = color - sample_blur(uv, effect.header.y);
        let denoise_result = mix(color, denoise_filtered, effect.header.w) + denoise_detail * effect.p0.x;
        color = mix(denoise_original, max(denoise_result, vec3f(0.0)), effect.p0.y);
      }
      case 223u: {
        let clarity_original = color;
        let clarity_soft = sample_blur(uv, effect.header.y);
        let clarity_level = clamp(luminance(color), 0.0, 1.0);
        let clarity_midtone = pow(1.0 - abs(clarity_level * 2.0 - 1.0), max(0.1, 2.0 - effect.header.w));
        let clarity_result = max(color + (color - clarity_soft) * effect.header.z * clarity_midtone, vec3f(0.0));
        color = mix(clarity_original, clarity_result, effect.p0.x);
      }
      case 224u: {
        let local_original = color;
        let local_soft = sample_blur(uv, effect.header.y);
        let local_detail = color - local_soft;
        let local_gate = smoothstep(
          effect.header.w,
          effect.header.w + 0.02,
          luminance(abs(local_detail)),
        );
        let local_highlight_protection = 1.0 - smoothstep(0.65, 1.15, luminance(color)) * effect.p0.x;
        let local_result = max(
          color + local_detail * effect.header.z * local_gate * local_highlight_protection,
          vec3f(0.0),
        );
        color = mix(local_original, local_result, effect.p0.y);
      }
      case 225u: {
        let sharpen_original = color;
        var sharpen_soft = sample_blur(uv, effect.header.y);
        if effect.p0.x > 0.5 && effect.p0.x < 1.5 {
          let sharpen_offset = vec2f(effect.header.y) / resolution;
          sharpen_soft = (
            textureSample(hdr_scene, linear_sampler, uv + sharpen_offset).rgb
              + textureSample(hdr_scene, linear_sampler, uv - sharpen_offset).rgb
              + textureSample(hdr_scene, linear_sampler, uv + vec2f(sharpen_offset.x, -sharpen_offset.y)).rgb
              + textureSample(hdr_scene, linear_sampler, uv + vec2f(-sharpen_offset.x, sharpen_offset.y)).rgb
          ) * 0.25;
        } else if effect.p0.x > 1.5 {
          let sharpen_direction = vec2f(cos(effect.p0.y), sin(effect.p0.y))
            * effect.header.y / resolution;
          sharpen_soft = (
            textureSample(hdr_scene, linear_sampler, uv + sharpen_direction).rgb
              + textureSample(hdr_scene, linear_sampler, uv - sharpen_direction).rgb
          ) * 0.5;
        }
        let sharpen_detail = color - sharpen_soft;
        let sharpen_gate = smoothstep(
          effect.header.w,
          effect.header.w + 0.01,
          luminance(abs(sharpen_detail)),
        );
        let sharpen_result = max(color + sharpen_detail * effect.header.z * sharpen_gate, vec3f(0.0));
        color = mix(sharpen_original, sharpen_result, effect.p0.z);
      }
      case 226u: {
        let frequency_original = color;
        let frequency_low = sample_blur(uv, effect.header.y);
        let frequency_high = color - frequency_low;
        var frequency_result = frequency_low;
        if effect.header.z > 0.5 && effect.header.z < 1.5 {
          frequency_result = frequency_high + vec3f(0.5);
        } else if effect.header.z > 1.5 {
          frequency_result = frequency_low + frequency_high * effect.header.w;
        }
        color = mix(frequency_original, max(frequency_result, vec3f(0.0)), effect.p0.x);
      }
`;
