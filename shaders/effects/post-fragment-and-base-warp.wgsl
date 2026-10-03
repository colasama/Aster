

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let resolution = settings.resolution_time_exposure.xy;
  let time = settings.resolution_time_exposure.z;
  let effect_count = u32(settings.program.x);
  var uv = input.uv;
  var active_warp_mask = 1.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (index >= effect_count) { break; }
    let effect = effect_ops[index];
    let code = u32(effect.header.x + 0.5);
    let uv_before_effect = uv;
    let centered = uv - vec2f(0.5);
    switch code {
      case 1u: {
        let blocks = max(effect.header.yz, vec2f(1.0));
        uv = (floor(uv * blocks) + vec2f(0.5)) / blocks;
      }
      case 5u: {
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = centered * aspect;
        let radius = max(effect.header.z / resolution.y, 0.0001);
        let falloff = clamp(1.0 - length(delta) / radius, 0.0, 1.0);
        uv = rotate2(delta, effect.header.y * falloff * falloff) / aspect + vec2f(0.5);
      }
      case 6u: {
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = centered * aspect;
        let radius = max(effect.header.y / resolution.y, 0.0001);
        let distance = length(delta) / radius;
        let falloff = pow(clamp(1.0 - distance, 0.0, 1.0), max(effect.header.w, 0.01));
        uv = delta * (1.0 - effect.header.z * falloff * 0.65) / aspect + vec2f(0.5);
      }
      case 7u: {
        let direction = vec2f(cos(effect.header.w), sin(effect.header.w));
        let phase = dot(uv * resolution, direction) / max(effect.header.z, 1.0) * 6.283185 + time * effect.p0.x;
        uv += vec2f(-direction.y, direction.x) * sin(phase) * effect.header.y / resolution;
      }
      case 24u: {
        let scale = max(effect.header.w, 0.001);
        uv = rotate2(centered, -effect.p0.x) / scale + vec2f(0.5) - effect.header.yz / resolution;
      }
      case 25u: {
        let position = uv * resolution / max(effect.header.z, 1.0) + vec2f(effect.p0.x + time * 0.1);
        let noise = vec2f(fractal_noise(position), fractal_noise(position + vec2f(31.7, 9.2))) - vec2f(0.5);
        uv += noise * effect.header.y / resolution;
      }
      case 26u: {
        let noise = vec2f(value_noise(uv * 13.0 + time), value_noise(uv * 17.0 - time)) - vec2f(0.5);
        uv += noise * effect.header.yz / resolution;
      }
      case 41u: {
        var reflected = rotate2(uv - vec2f(0.5), -effect.header.y);
        let mirror_line = effect.header.z - 0.5;
        reflected.x = mirror_line + abs(reflected.x - mirror_line);
        uv = rotate2(reflected, effect.header.y) + vec2f(0.5);
      }
      case 42u: {
        let tiled = (uv - vec2f(0.5)) * max(effect.header.yz, vec2f(0.01)) + vec2f(0.5);
        if effect.header.w > 0.5 {
          uv = abs(fract(tiled * 0.5) * 2.0 - vec2f(1.0));
        } else {
          uv = fract(tiled);
        }
      }
      case 47u: {
        let centered_uv = (uv - vec2f(0.5)) / max(effect.header.z, 0.01);
        let radius_squared = dot(centered_uv, centered_uv);
        uv = centered_uv * (1.0 + effect.header.y * radius_squared) + vec2f(0.5);
      }
      case 51u: {
        let segments = max(effect.header.y, 2.0);
        let rotation = effect.header.z;
        let center = vec2f(effect.header.w, effect.p0.x);
        let aspect = vec2f(resolution.x / resolution.y, 1.0);
        let delta = (uv - center) * aspect;
        let radius = length(delta) / max(effect.p0.y, 0.01);
        let sector = 6.283185 / segments;
        let triangle = abs(fract((atan2(delta.y, delta.x) - rotation) / sector + 0.5) * 2.0 - 1.0);
        let folded_angle = triangle * sector * 0.5 + rotation;
        uv = center + vec2f(cos(folded_angle), sin(folded_angle)) * radius / aspect;
      }
