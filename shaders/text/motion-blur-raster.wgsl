
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
struct SampleWeight {
  value: vec4f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@group(0) @binding(0) var sample_texture: texture_2d<f32>;
@group(0) @binding(1) var sample_sampler: sampler;
@group(0) @binding(2) var<uniform> sample_weight: SampleWeight;

@fragment fn accumulate_fragment(input: VertexOutput) -> @location(0) vec4f {
  let straight = textureSampleLevel(sample_texture, sample_sampler, input.uv, 0.0);
  let alpha = straight.a * sample_weight.value.x;
  return vec4f(straight.rgb * alpha, alpha);
}

@fragment fn resolve_fragment(input: VertexOutput) -> @location(0) vec4f {
  let pixel = clamp(
    vec2i(input.position.xy),
    vec2i(0),
    vec2i(textureDimensions(sample_texture)) - vec2i(1),
  );
  let premultiplied = textureLoad(sample_texture, pixel, 0);
  let straight = select(vec3f(0.0), premultiplied.rgb / max(premultiplied.a, 0.000001),
    premultiplied.a > 0.000001);
  return vec4f(straight, premultiplied.a);
}
