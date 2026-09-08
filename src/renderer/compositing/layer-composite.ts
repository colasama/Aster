import { BLEND_MODES, type BlendMode, type Layer } from "../../core/types";

export function needsBackdropBlend(mode: BlendMode): boolean {
  return mode !== "normal" && mode !== "add" && mode !== "screen";
}

export function needsLayerIsolation(layer: Layer): boolean {
  return needsBackdropBlend(layer.blendMode) || layer.effects.some((effect) => effect.enabled);
}

// Both inputs and the result are premultiplied linear HDR. Transparent backdrop
// pixels must preserve the source, including in multiply and darken modes.
export const layerCompositeShader = /* wgsl */ `
override blend_mode: u32 = 0u;
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[index], 0.0, 1.0);
}
fn overlay(b: vec3f, s: vec3f) -> vec3f {
  return select(2.0*b*s, 1.0-2.0*(1.0-b)*(1.0-s), b > vec3f(0.5));
}
fn blend(b: vec3f, s: vec3f) -> vec3f {
  switch blend_mode {
    case 2u: { return b*s; }
    case 4u: { return overlay(b,s); }
    case 5u: { return min(b,s); }
    case 6u: { return max(b,s); }
    case 7u: { return select(select(1.0-min(vec3f(1.0),(1.0-b)/max(s,vec3f(0.00001))),vec3f(0.0),s<=vec3f(0.0)),vec3f(1.0),b>=vec3f(1.0)); }
    case 8u: { return select(select(min(vec3f(1.0),b/max(1.0-s,vec3f(0.00001))),vec3f(1.0),s>=vec3f(1.0)),vec3f(0.0),b<=vec3f(0.0)); }
    case 9u: {
      let d = select(((16.0*b-12.0)*b+4.0)*b,sqrt(max(b,vec3f(0.0))),b>vec3f(0.25));
      return select(b-(1.0-2.0*s)*b*(1.0-b),b+(2.0*s-1.0)*(d-b),s>vec3f(0.5));
    }
    case 10u: { return overlay(s,b); }
    case 11u: { return abs(b-s); }
    case 12u: { return b+s-2.0*b*s; }
    default: { return s; }
  }
}
@fragment fn fragment_main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let s = textureLoad(source,vec2i(p.xy),0);
  let b = textureLoad(backdrop,vec2i(p.xy),0);
  let sc = s.rgb/max(s.a,0.00001);
  let bc = b.rgb/max(b.a,0.00001);
  let rgb = (1.0-s.a)*b.rgb+(1.0-b.a)*s.rgb+s.a*b.a*blend(bc,sc);
  return vec4f(max(rgb,vec3f(0.0)),s.a+b.a*(1.0-s.a));
}
`;

export class LayerCompositor {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipelines = new Map<BlendMode, GPURenderPipeline>();
  #bindings?: GPUBindGroup;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.#device = device;
    this.#format = format;
    this.#layout = device.createBindGroupLayout({
      entries: [0, 1].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" as const },
      })),
    });
  }

  resize(source: GPUTexture, backdrop: GPUTexture): void {
    this.#bindings = this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: backdrop.createView() },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, target: GPUTexture, mode: BlendMode): void {
    let pipeline = this.#pipelines.get(mode);
    if (!pipeline) {
      const module = this.#device.createShaderModule({
        label: "Alpha-correct layer blending",
        code: layerCompositeShader,
      });
      pipeline = this.#device.createRenderPipeline({
        label: `Layer blend · ${mode}`,
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
        vertex: { module, entryPoint: "vertex_main" },
        fragment: {
          module,
          entryPoint: "fragment_main",
          constants: { blend_mode: BLEND_MODES.indexOf(mode) },
          targets: [{ format: this.#format }],
        },
      });
      this.#pipelines.set(mode, pipeline);
    }
    if (!this.#bindings) throw new Error("Layer blend inputs unavailable");
    const pass = encoder.beginRenderPass({
      label: `Backdrop blend · ${mode}`,
      colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#bindings);
    pass.draw(3);
    pass.end();
  }
}
