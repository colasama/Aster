
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}
@group(0) @binding(0) var surface_texture: texture_2d<f32>;
@group(0) @binding(1) var surface_sampler: sampler;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(surface_texture, surface_sampler, input.uv);
  let alpha = sampled.a * input.color.a;
  if (alpha <= 0.00001) { discard; }
  return vec4f(
    sampled.rgb * input.color.rgb * input.color.a,
    alpha,
  );
}
