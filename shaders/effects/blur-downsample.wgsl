
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn downsample_taps(uv: vec2f, half_texel: vec2f) -> array<vec4f, 5> {
  return array<vec4f, 5>(
    textureSample(source_tex, linear_sampler, uv),
    textureSample(source_tex, linear_sampler, uv + vec2f(-half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(-half_texel.x, half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(half_texel.x, half_texel.y)),
  );
}

fn downsample_rgb(taps: array<vec4f, 5>) -> vec3f {
  return (taps[0] * 4.0 + taps[1] + taps[2] + taps[3] + taps[4]).rgb / 8.0;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let half_texel = vec2f(0.5) / vec2f(textureDimensions(source_tex));
  return vec4f(downsample_rgb(downsample_taps(input.uv, half_texel)), 1.0);
}
