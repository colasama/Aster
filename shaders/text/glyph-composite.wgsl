struct GlyphUniform {
  origin_size: vec4f,
  atlas_rect: vec4f,
  row_x: vec4f,
  row_y: vec4f,
  color: vec4f,
  viewport: vec4f,
}
struct GlyphVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(0) @binding(0) var glyph_texture: texture_2d<f32>;
@group(0) @binding(1) var glyph_sampler: sampler;
@group(0) @binding(2) var<uniform> glyph: GlyphUniform;

@vertex fn glyph_vertex(@builtin(vertex_index) index: u32) -> GlyphVertex {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
    vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let corner = corners[index];
  let local = vec3f(glyph.origin_size.xy + corner * glyph.origin_size.zw, 1);
  let point = vec2f(dot(glyph.row_x.xyz, local), dot(glyph.row_y.xyz, local));
  var out: GlyphVertex;
  out.position = vec4f(point / glyph.viewport.xy * vec2f(2, -2) + vec2f(-1, 1), 0, 1);
  out.uv = (glyph.atlas_rect.xy + corner * glyph.atlas_rect.zw) / glyph.viewport.w;
  return out;
}

// Canvas glyph compositing uses encoded sRGB premultiplication. Decode only after resolving.
@fragment fn glyph_fragment(input: GlyphVertex) -> @location(0) vec4f {
  let lower = (glyph.atlas_rect.xy + vec2f(0.5)) / glyph.viewport.w;
  let upper = (glyph.atlas_rect.xy + glyph.atlas_rect.zw - vec2f(0.5)) / glyph.viewport.w;
  let pixel = textureSampleLevel(glyph_texture, glyph_sampler, clamp(input.uv, lower, upper), 0);
  if glyph.viewport.z > 0.5 {
    return pixel * glyph.color.a;
  }
  let alpha = pixel.r * glyph.color.a;
  return vec4f(glyph.color.rgb * alpha, alpha);
}

@vertex fn resolve_vertex(@builtin(vertex_index) index: u32) -> GlyphVertex {
  let points = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: GlyphVertex;
  out.position = vec4f(points[index], 0, 1);
  out.uv = vec2f(0);
  return out;
}

@fragment fn resolve_fragment(input: GlyphVertex) -> @location(0) vec4f {
  let pixel = textureLoad(glyph_texture, vec2i(input.position.xy), 0);
  return vec4f(select(vec3f(0), pixel.rgb / max(pixel.a, 0.000001), pixel.a > 0), pixel.a);
}
