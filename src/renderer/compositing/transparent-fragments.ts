import { layerCompositeShader } from "./layer-composite";

export const FRAGMENT_BYTES = 24;
export const TRANSPARENCY_TILE = 512;
export const MAX_PIXEL_FRAGMENTS = 128;

export const fragmentBindings = /* wgsl */ `
struct Fragment { rg: u32, ba: u32, depth: f32, next: u32, order: u32, mode: u32 }
struct FragmentSettings { origin: vec2u, extent: vec2u, capacity: u32, pad: u32, reserved: vec2u }
struct FragmentDraw { order: u32, mode: u32, pad: vec2u }
@group(3) @binding(0) var<storage, read_write> heads: array<atomic<u32>>;
@group(3) @binding(1) var<storage, read_write> fragments: array<Fragment>;
@group(3) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(3) @binding(3) var<uniform> fragment_settings: FragmentSettings;
@group(3) @binding(4) var backdrop_texture: texture_2d<f32>;
@group(3) @binding(5) var<uniform> fragment_draw: FragmentDraw;
fn save_fragment(position: vec4f, color: vec4f) {
  if (color.a <= 0.00001) { return; }
  let xy = vec2u(position.xy) - fragment_settings.origin;
  let pixel = xy.y * fragment_settings.extent.x + xy.x;
  let index = atomicAdd(&counters[0], 1u) + 1u;
  if (index >= fragment_settings.capacity) { atomicStore(&counters[1], 1u); return; }
  let previous = atomicExchange(&heads[pixel], index);
  fragments[index] = Fragment(pack2x16float(color.rg), pack2x16float(color.ba), position.z, previous, fragment_draw.order, fragment_draw.mode);
}
`;

/** Wraps the existing material fragment, retaining exactly the same lighting and alpha math. */
export function captureFragmentShader(code: string): string {
  const signature =
    /@fragment\s+fn\s+fragment_main\(input:\s*(\w+)\)\s*->\s*@location\(0\)\s*vec4f/;
  const match = code.match(signature);
  if (!match) throw new Error("Material does not expose a capturable fragment entry point");
  return (
    code.replace(signature, `fn source_fragment(input: ${match[1]}) -> vec4f`) +
    fragmentBindings +
    `
@fragment fn capture_fragment(input: ${match[1]}) -> @location(0) vec4f {
  let color = source_fragment(input);
  save_fragment(input.position, color);
  return vec4f(0.0);
}`
  );
}

const blendFunctions = layerCompositeShader
  .slice(layerCompositeShader.indexOf("fn overlay"), layerCompositeShader.indexOf("@fragment"))
  .replace("fn blend(b: vec3f, s: vec3f)", "fn blend(mode: u32, b: vec3f, s: vec3f)")
  .replace("switch blend_mode", "switch mode");

export const resolveFragmentsShader =
  fragmentBindings +
  blendFunctions +
  /* wgsl */ `
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(p[index],0.0,1.0);
}
@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let xy = vec2u(position.xy) - fragment_settings.origin;
  let first = atomicLoad(&heads[xy.y * fragment_settings.extent.x + xy.x]);
  var result = textureLoad(backdrop_texture, vec2i(position.xy), 0);
  // Stable insertion sort keeps typical two/three-fragment pixels cheap. Storage stays tiled.
  var indices: array<u32, ${MAX_PIXEL_FRAGMENTS}>;
  var count = 0u;
  var index = first;
  loop {
    if (index == 0u) { break; }
    if (count == ${MAX_PIXEL_FRAGMENTS}u) { atomicStore(&counters[1],1u); return vec4f(1.0,0.0,1.0,1.0); }
    let f = fragments[index];
    var slot = count;
    loop {
      if (slot == 0u) { break; }
      let prior = fragments[indices[slot-1u]];
      if (prior.depth > f.depth || (prior.depth == f.depth && prior.order <= f.order)) { break; }
      indices[slot] = indices[slot-1u]; slot -= 1u;
    }
    indices[slot] = index; count += 1u; index = f.next;
  }
  for (var i=0u; i<count; i+=1u) {
    let f = fragments[indices[i]];
    let s = vec4f(unpack2x16float(f.rg), unpack2x16float(f.ba));
    let alpha = s.a + result.a * (1.0-s.a);
    if (f.mode == 1u) { result = vec4f(result.rgb+s.rgb,alpha); }
    else if (f.mode == 3u) { result = vec4f(s.rgb+result.rgb*(1.0-s.rgb),alpha); }
    else {
      let mixed = blend(f.mode, result.rgb/max(result.a,0.00001), s.rgb/max(s.a,0.00001));
      result = vec4f((1.0-s.a)*result.rgb+(1.0-result.a)*s.rgb+s.a*result.a*mixed, alpha);
    }
  }
  return result;
}
`;
