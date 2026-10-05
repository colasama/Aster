import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  type AuxiliaryBufferKind,
  type BufferVisualization,
  type DepthEffectVisualization,
  type SceneBufferVisualization,
  type SurfaceEffectVisualization,
} from "../gpu/render-buffers";
import { sharedShaders } from "../gpu/shared-shader-catalog";

const SCENE_MODES: Readonly<Record<Exclude<SceneBufferVisualization, "beauty">, number>> = {
  linearColor: 0,
  luminance: 1,
  alpha: 2,
};

/** Full-screen views of the real HDR scene and auxiliary GPU attachments. */
export class SceneBufferVisualizer {
  readonly #device: GPUDevice;
  readonly #scenePipeline: GPURenderPipeline;
  readonly #floatPipeline: GPURenderPipeline;
  readonly #uintPipeline: GPURenderPipeline;
  readonly #sceneUniform: GPUBuffer;
  readonly #auxiliaryUniform: GPUBuffer;
  #sceneBindGroup?: GPUBindGroup;
  readonly #auxiliaryBindGroups = new Map<AuxiliaryBufferKind, GPUBindGroup>();

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    this.#sceneUniform = createUniform(device, "Scene buffer visualization mode");
    this.#auxiliaryUniform = createUniform(device, "Auxiliary buffer visualization range");
    const sceneModule = device.createShaderModule({
      label: "Scene buffer visualizer",
      code: sceneShader,
    });
    this.#scenePipeline = createPipeline(
      device,
      sceneModule,
      outputFormat,
      "Scene buffer visualization",
    );
    const floatModule = device.createShaderModule({
      label: "Float auxiliary visualizer",
      code: floatShader,
    });
    this.#floatPipeline = createPipeline(
      device,
      floatModule,
      outputFormat,
      "Float auxiliary visualization",
    );
    const uintModule = device.createShaderModule({
      label: "Integer auxiliary visualizer",
      code: uintShader,
    });
    this.#uintPipeline = createPipeline(
      device,
      uintModule,
      outputFormat,
      "Integer auxiliary visualization",
    );
  }

  setSource(source: GPUTexture): void {
    this.#sceneBindGroup = this.#createBindGroup(
      this.#scenePipeline,
      source,
      this.#sceneUniform,
      "Scene buffer visualization resources",
    );
  }

  setAuxiliarySources(
    sources: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>,
    worldRange: readonly [number, number],
  ): void {
    this.#auxiliaryBindGroups.clear();
    const span = Math.max(1e-6, worldRange[1] - worldRange[0]);
    this.#device.queue.writeBuffer(
      this.#auxiliaryUniform,
      0,
      new Float32Array([worldRange[0], 1 / span]),
    );
    for (const [kind, source] of sources) {
      const pipeline =
        AUXILIARY_BUFFER_DESCRIPTORS[kind].sampleType === "uint"
          ? this.#uintPipeline
          : this.#floatPipeline;
      this.#auxiliaryBindGroups.set(
        kind,
        this.#createBindGroup(
          pipeline,
          source,
          AUXILIARY_BUFFER_DESCRIPTORS[kind].sampleType === "uint"
            ? undefined
            : this.#auxiliaryUniform,
          `${kind} visualization resources`,
        ),
      );
    }
  }

  clearAuxiliarySources(): void {
    this.#auxiliaryBindGroups.clear();
  }

  destroy(): void {
    this.#sceneBindGroup = undefined;
    this.#auxiliaryBindGroups.clear();
    this.#sceneUniform.destroy();
    this.#auxiliaryUniform.destroy();
  }

  encode(
    pass: GPURenderPassEncoder,
    mode: Exclude<
      BufferVisualization,
      "beauty" | DepthEffectVisualization | SurfaceEffectVisualization
    >,
  ): void {
    if (mode === "linearColor" || mode === "luminance" || mode === "alpha") {
      if (!this.#sceneBindGroup) throw new Error("Scene buffer visualizer has no source texture");
      this.#device.queue.writeBuffer(this.#sceneUniform, 0, new Uint32Array([SCENE_MODES[mode]]));
      pass.setPipeline(this.#scenePipeline);
      pass.setBindGroup(0, this.#sceneBindGroup);
    } else {
      const bindGroup = this.#auxiliaryBindGroups.get(mode);
      if (!bindGroup) throw new Error(`Auxiliary ${mode} visualization is unavailable`);
      const pipeline =
        AUXILIARY_BUFFER_DESCRIPTORS[mode].sampleType === "uint"
          ? this.#uintPipeline
          : this.#floatPipeline;
      this.#device.queue.writeBuffer(
        this.#auxiliaryUniform,
        8,
        new Uint32Array([mode === "normal" ? 0 : mode === "motionVector" ? 2 : 1]),
      );
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
    }
    pass.draw(3);
  }

  #createBindGroup(
    pipeline: GPURenderPipeline,
    source: GPUTexture,
    uniform: GPUBuffer | undefined,
    label: string,
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        ...(uniform ? [{ binding: 1, resource: { buffer: uniform } }] : []),
      ],
    });
  }
}

function createUniform(device: GPUDevice, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function createPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  label: string,
): GPURenderPipeline {
  return device.createRenderPipeline({
    label,
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

const sceneShader = sharedShaders.source("diagnostic-scene");

const floatShader = sharedShaders.source("diagnostic-float");

const uintShader = sharedShaders.source("diagnostic-uint");
