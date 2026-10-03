
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

struct BrightpassParameters {
  threshold: f32,
  padding: vec3f,
}

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var<uniform> params: BrightpassParameters;

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let half_texel = vec2f(0.5) / vec2f(textureDimensions(source_tex));
  let taps = array<vec4f, 5>(
    textureSample(source_tex, linear_sampler, input.uv),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(-half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(-half_texel.x, half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(half_texel.x, half_texel.y)),
  );
  var sum = vec3f(0.0);
  for (var i = 0; i < 5; i += 1) {
    let level = dot(taps[i].rgb, vec3f(0.2126, 0.7152, 0.0722));
    let weight = max(level - params.threshold, 0.0) / max(level, 0.0001);
    sum += taps[i].rgb * weight * select(1.0, 4.0, i == 0);
  }
  return vec4f(sum / 8.0, 1.0);
}
