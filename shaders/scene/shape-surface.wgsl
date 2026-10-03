

fn safe_normalize3(value: vec3f, fallback: vec3f) -> vec3f {
  let length_squared = dot(value, value);
  if length_squared > 0.00000001 {
    return value * inverseSqrt(length_squared);
  }
  return fallback;
}

fn shadow_position(world_position: vec3f) -> vec3f {
  let relative = world_position - lighting.shadow_center_bias.xyz;
  return vec3f(
    dot(relative, lighting.shadow_x_scale.xyz) * lighting.shadow_x_scale.w,
    dot(relative, lighting.shadow_y_scale.xyz) * lighting.shadow_y_scale.w,
    0.5 - dot(relative, lighting.shadow_z_scale.xyz) * lighting.shadow_z_scale.w,
  );
}

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
  @location(4) normal: vec3f,
  @location(5) material: vec4f,
  @location(6) world_position: vec3f,
  @location(7) shape_style_color: vec4f,
  @location(8) shape_style_parameters: vec4f,
  @location(9) gradient_style_color: vec4f,
  @location(10) gradient_style_parameters: vec4f,
  @location(11) tangent: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.shape = shape;
  output.normal = normal;
  output.material = material;
  output.world_position = world_position;
  output.shape_style_color = shape_style_color;
  output.shape_style_parameters = shape_style_parameters;
  output.gradient_style_color = gradient_style_color;
  output.gradient_style_parameters = gradient_style_parameters;
  output.tangent = tangent;
  return output;
}

fn analytic_shape_distance(uv: vec2f, style: vec4f, gradient: vec4f) -> f32 {
  let centered = uv - vec2f(0.5);
  if style.z > 2.5 {
    let along = clamp(centered.x + 0.5, 0.0, 1.0);
    let line_radius = max(style.x * 0.5, 0.003);
    return select(
      max(abs(centered.y) - line_radius, abs(centered.x) - 0.5),
      length(centered - vec2f(along - 0.5, 0.0)) - line_radius,
      style.w > 0.5,
    );
  }
  if style.z > 1.5 { return length(centered) - 0.5; }
  let aspect = max(gradient.zw, vec2f(1.0));
  let radius = style.y;
  let rounded = abs(centered) * aspect - (0.5 * aspect - vec2f(radius));
  return length(max(rounded, vec2f(0.0)))
    + min(max(rounded.x, rounded.y), 0.0) - radius;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var alpha = input.color.a;
  // Derivatives run before divergent shape branches and retain a one-pixel
  // edge footprint even when a circle is much larger than the viewport.
  let shape_distance = analytic_shape_distance(
    input.uv, input.shape_style_parameters, input.gradient_style_parameters,
  );
  let antialias = max(fwidth(shape_distance), 0.0000001);
  let uv_derivative = max(fwidth(input.uv.x), 0.0000001);
  if input.shape_style_parameters.z > 0.5 {
    let centered = input.uv - vec2f(0.5);
    var fill_color = input.color.rgb;
    if input.gradient_style_parameters.x > 0.5 {
      let angle = input.gradient_style_parameters.y;
      let linear_amount = clamp(
        dot(centered, vec2f(cos(angle), sin(angle))) + 0.5,
        0.0,
        1.0,
      );
      let radial_amount = clamp(length(centered) * 1.41421356, 0.0, 1.0);
      let gradient_amount = select(
        linear_amount,
        radial_amount,
        input.gradient_style_parameters.x > 1.5,
      );
      fill_color = mix(fill_color, input.gradient_style_color.rgb, gradient_amount);
      alpha *= mix(1.0, input.gradient_style_color.a, gradient_amount);
    }
    if input.shape_style_parameters.z > 3.5 {
      return vec4f(fill_color * alpha, alpha);
    }
    var dash_coverage = 1.0;
    if input.shape_style_parameters.z > 2.5 {
      let segment_start = vec2f(-0.5, 0.0);
      let segment = vec2f(1.0, 0.0);
      let relative = centered - segment_start;
      let along = clamp(dot(relative, segment) / dot(segment, segment), 0.0, 1.0);
      let dash = input.gradient_style_parameters.z;
      let gap = input.gradient_style_parameters.w;
      if dash > 0.0 && gap > 0.0 {
        let phase = fract(along / (dash + gap)) * (dash + gap);
        dash_coverage = 1.0 - smoothstep(dash, dash + uv_derivative, phase);
      }
    }
    let coverage = (1.0 - smoothstep(0.0, antialias, shape_distance)) * dash_coverage;
    let stroke_width = input.shape_style_parameters.x;
    var stroke_coverage = select(
      0.0,
      1.0 - smoothstep(stroke_width, stroke_width + antialias, abs(shape_distance)),
      stroke_width > 0.0,
    );
    if input.shape_style_parameters.z > 2.5 { stroke_coverage = 1.0; }
    let stroke_weight = stroke_coverage * input.shape_style_color.a;
    let fill_alpha = alpha * coverage * (1.0 - stroke_weight);
    let stroke_alpha = stroke_weight * input.material.w * coverage;
    return vec4f(
      fill_color * fill_alpha + input.shape_style_color.rgb * stroke_alpha,
      fill_alpha + stroke_alpha,
    );
  }
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  alpha *= smoothstep(0.0, 0.025, edge);
  var color = input.color.rgb;
  if input.material.w > 0.5 {
    