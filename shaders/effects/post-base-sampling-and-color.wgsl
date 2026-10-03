
      case 106u: {
        active_warp_mask = effect_mask_value(effect, input.uv, resolution);
      }
      case 107u: {
        active_warp_mask = 1.0;
      }
      default: {}
    }
    if code != 106u && code != 107u {
      uv = mix(uv_before_effect, uv, active_warp_mask);
    }
  }

  let exposure = settings.resolution_time_exposure.w;
  let contrast = settings.color.x;
  let saturation = settings.color.y;
  let temperature = settings.color.z;
  let tint = settings.color.w;
  let pivot = settings.grading.x;
  let lift = settings.grading.y;
  let gain = settings.grading.z;
  let glow = settings.optical.x;
  let threshold = settings.optical.y;
  let blur_radius = settings.optical.z;
  let chromatic = settings.optical.w;
  let pixel = vec2f(1.0) / resolution;
  let chromatic_offset = pixel * chromatic * (uv - vec2f(0.5));

  let base = textureSample(hdr_scene, linear_sampler, uv);
  var alpha = base.a;
  let linear_output = settings.program.y > 0.5;
  var color = base.rgb;
  if chromatic == 0.0 && blur_radius == 0.0 && glow == 0.0 {
    if alpha > 0.00001 {
      color /= alpha;
    }
  } else {
    color = vec3f(
      textureSample(hdr_scene, linear_sampler, uv + chromatic_offset).r,
      base.g,
      textureSample(hdr_scene, linear_sampler, uv - chromatic_offset).b,
    );
    if alpha > 0.00001 {
      color /= alpha;
    }
    let blurred = sample_blur(uv, blur_radius);
    let blur_mix = smoothstep(0.0, 1.0, blur_radius / 8.0);
    color = mix(color, blurred, blur_mix);
    let blurred_luminance = luminance(blurred);
    let highlight = max(blurred_luminance - threshold, 0.0) / max(blurred_luminance, 0.0001);
    color += blurred * highlight * glow;
  }

  color *= exp2(exposure);
  color *= vec3f(1.0 + temperature * 0.16, 1.0 + tint * 0.08, 1.0 - temperature * 0.16);
  color += lift;
  color = (color - vec3f(pivot)) * contrast + vec3f(pivot);
  color *= gain;
  let gray = luminance(color);
  color = mix(vec3f(gray), color, saturation);
  color = pow(max(color, vec3f(0.0)), vec3f(1.0 / settings.finish.z));
  color = mix(color, vec3f(gray * 0.75 + 0.08), settings.finish.w);

  var effect_time = time;
  var active_pixel_mask = 1.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (index >= effect_count) { break; }
    let effect = effect_ops[index];
    let code = u32(effect.header.x + 0.5);
    let color_before_effect = color;
    let alpha_before_effect = alpha;
    switch code {
      case 2u: {
        let levels = max(effect.header.y, 2.0);
        color = floor(clamp(color, vec3f(0.0), vec3f(1.0)) * (levels - 1.0) + 0.5) / (levels - 1.0);
      }
      case 3u: {
        let mapped = mix(effect.header.yzw, effect.p0.yzw, clamp(luminance(color), 0.0, 1.0));
        color = mix(color, mapped, effect.p0.x);
      }
      case 4u: {
        color *= effect.header.yzw;
        color = mix(color, vec3f(luminance(color)), effect.p0.x);
      }
      case 8u: {
        let offset = vec2f(1.0) / resolution;
        let horizontal = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb);
        let vertical = luminance(textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb);
        var edge = length(vec2f(horizontal, vertical)) * 4.0;
        edge = mix(edge, 1.0 - edge, effect.header.y);
        color = mix(vec3f(edge), color, effect.header.z);
      }
      case 9u: {
        let direction = vec2f(cos(effect.header.y), sin(effect.header.y));
        let offset = direction * effect.header.z / resolution;
        let relief = luminance(textureSample(hdr_scene, linear_sampler, uv + offset).rgb)
          - luminance(textureSample(hdr_scene, linear_sampler, uv - offset).rgb);
        let embossed = vec3f(0.5 + relief * effect.header.w);
        color = mix(embossed, color, effect.p0.x);
      }
      case 10u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z));
        let coordinate = dot(uv - vec2f(0.5), direction);
        var edge = effect.header.y - 0.5;
        if abs(effect.p0.x) > 0.00001 {
          let tangent = vec2f(-direction.y, direction.x);
          let phase = dot(uv * resolution, tangent) / max(effect.p0.y, 1.0) * 6.283185
            + effect.p0.z + effect_time * effect.p0.w;
          let amplitude = effect.p0.x / max(length(resolution * direction), 1.0);
          let available = max(0.0, min(effect.header.y, 1.0 - effect.header.y));
          edge += clamp(amplitude, -available, available) * sin(phase);
        }
        let feather = effect.header.w / max(resolution.x, resolution.y);
        alpha *= 1.0 - smoothstep(edge - feather, edge + feather + 0.00001, coordinate);
      }
      case 11u: {
        var angle = atan2(uv.y - 0.5, uv.x - 0.5) - effect.header.z;
        angle = fract(angle / 6.283185 + 1.0);
        let feather = max(effect.header.w / 6.283185, 0.00001);
        alpha *= 1.0 - smoothstep(effect.header.y - feather, effect.header.y + feather, angle);
      }
      case 12u: {
        let level = luminance(color);
        let balance = clamp(level + effect.p0.y * 0.25, 0.0, 1.0);
        let shadow = hue_color(effect.header.y) * color * effect.header.z;
        let highlight_color = hue_color(effect.header.w) * color * effect.p0.x;
        color += mix(shadow, highlight_color, balance);
      }
      case 13u: {
        let cell = floor(input.position.xy / max(effect.header.y, 1.0));
        let selector = fract((cell.x + cell.y) * 0.5) * 2.0;
        let generated = mix(effect.p0.xyz, effect.p1.xyz, step(0.5, selector));
        color = mix(color, generated, effect.header.z);
      }
      case 14u: {
        let cell = fract(input.position.xy / max(effect.header.yz, vec2f(1.0)));
        let border = effect.header.w / max(effect.header.y, effect.header.z);
        let line = max(1.0 - step(border, cell.x), 1.0 - step(border, cell.y));
        color = mix(color, effect.p0.xyz, line);
      }
      case 15u: {
        let top = mix(effect.header.yzw, effect.p0.yzw, uv.x);
        let bottom = mix(effect.p1.yzw, effect.p2.yzw, uv.x);
        color = mix(color, mix(top, bottom, uv.y), effect.p0.x);
      }
      case 16u: {
        let position = input.position.xy / max(effect.header.w, 1.0) + vec2f(effect.p0.y + effect_time * 0.08);
        var generated = (fractal_noise(position) - 0.5) * effect.header.y + 0.5 + effect.header.z;
        generated = clamp(generated, 0.0, 1.0);
        color = vec3f(generated);
      }
      case 17u: {
        let low = sample_blur(uv, effect.header.z);
        let detail = color - low;
        let mask = step(effect.header.w, abs(luminance(detail)));
        color += detail * effect.header.y * mask;
      }
      case 18u: {
        let direction = vec2f(cos(effect.header.z), sin(effect.header.z)) * effect.header.y / resolution;
        color = (
          textureSample(hdr_scene, linear_sampler, uv - direction).rgb
          + textureSample(hdr_scene, linear_sampler, uv - direction * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv).rgb
          + textureSample(hdr_scene, linear_sampler, uv + direction * 0.5).rgb
          + textureSample(hdr_scene, linear_sampler, uv + direction).rgb
        ) * 0.2;
      }
      case 19u: {
        let delta = uv - vec2f(0.5);
        var total = textureSample(hdr_scene, linear_sampler, uv).rgb;
        for (var sample_index = 1u; sample_index < 5u; sample_index += 1u) {
          let amount = effect.header.y * f32(sample_index) * 0.25;
          let sample_uv = select(rotate2(delta, amount) + vec2f(0.5), uv - delta * amount, effect.header.z > 0.5);
          total += textureSample(hdr_scene, linear_sampler, sample_uv).rgb;
        }
        color = total * 0.2;
      }
      case 20u: {
        let distance = length(color - effect.header.yzw);
        let keep = smoothstep(effect.p0.x, effect.p0.x + effect.p0.y + 0.0001, distance);
        color.g *= 1.0 - (1.0 - keep) * effect.p0.z;
        alpha *= keep;
      }
      case 21u: {
        let level = luminance(color);
        let darker_keep = smoothstep(effect.header.z - effect.header.w, effect.header.z + effect.header.w, level);
        alpha *= select(darker_keep, 1.0 - darker_keep, effect.header.y > 0.5);
      }
      case 22u: {
        let key_channel = select(color.g, color.b, effect.header.y > 0.5);
        let other = select(max(color.r, color.b), max(color.r, color.g), effect.header.y > 0.5);
        let spill = max(key_channel - other * effect.header.w, 0.0) * effect.header.z;
        color = select(vec3f(color.r, color.g - spill, color.b), vec3f(color.r, color.g, color.b - spill), effect.header.y > 0.5);
      }
      case 23u: {
        let level = luminance(color);
        let shadow = 1.0 - smoothstep(0.0, 0.5, level);
        let highlight_weight = smoothstep(0.5, 1.0, level);
        let midtone = 1.0 - shadow - highlight_weight;
        let shift = effect.header.y * shadow + effect.header.z * midtone + effect.header.w * highlight_weight;
        color += vec3f(shift, 0.0, -shift);
      }
      case 27u: {
        let normalized = clamp((color - effect.header.y) / max(effect.header.z - effect.header.y, 0.0001), vec3f(0.0), vec3f(1.0));
        color = mix(vec3f(effect.p0.x), vec3f(effect.p0.y), pow(normalized, vec3f(1.0 / effect.header.w)));
      }
      case 28u: {
        let level = luminance(color);
        color += effect.header.y * (1.0 - level) + effect.header.w * level;
        color = (color - vec3f(0.5)) * (1.0 + effect.header.z) + vec3f(0.5);
      }
      case 29u: {
        let offset = vec2f(effect.header.y) / resolution;
        let a = textureSample(hdr_scene, linear_sampler, uv + vec2f(offset.x, 0.0)).rgb;
        let b = textureSample(hdr_scene, linear_sampler, uv - vec2f(offset.x, 0.0)).rgb;
        let c = textureSample(hdr_scene, linear_sampler, uv + vec2f(0.0, offset.y)).rgb;
        let d = textureSample(hdr_scene, linear_sampler, uv - vec2f(0.0, offset.y)).rgb;
        let maximum = max(max(a, b), max(c, d));
        let minimum = min(min(a, b), min(c, d));
        color = select(maximum, minimum, effect.header.z > 0.5);
      }
      case 30u: {
        effect_time = floor(effect_time * effect.header.y) / max(effect.header.y, 1.0);
      }
      case 31u: {
        color = hue_rotate(color, effect.header.y);
        let level = luminance(color);
        color = mix(vec3f(level), color, effect.header.z) + effect.header.w;
      }
