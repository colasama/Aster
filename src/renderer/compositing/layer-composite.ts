import { BLEND_MODES, type BlendMode, type Layer } from "../../core/types";
import { sharedShaders } from "../gpu/shared-shader-catalog";

export function needsBackdropBlend(mode: BlendMode): boolean {
  return mode !== "normal" && mode !== "add" && mode !== "screen";
}

export function needsLayerIsolation(layer: Layer): boolean {
  return needsBackdropBlend(layer.blendMode) || layer.effects.some((effect) => effect.enabled);
}

// Both inputs and the result are premultiplied linear HDR. Transparent backdrop
// pixels must preserve the source, including in multiply and darken modes.
export const layerCompositeShader = sharedShaders.source("layer-composite");

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
          constants: sharedShaders.pipelineConstants("layer-composite", {
            blend_mode: BLEND_MODES.indexOf(mode),
          }),
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
