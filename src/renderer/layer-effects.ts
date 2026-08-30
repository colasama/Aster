import type { BlendMode, Composition, Layer } from "../core/types";
import { gpuBlendState } from "./blend-state";
import { defaultPostProcessParameters } from "./effect-parameters";
import {
  compileEffectProgram,
  FLOATS_PER_EFFECT_OPERATION,
  MAX_EFFECT_OPERATIONS,
} from "./effect-program";
import { createLutSampler, createLutTexture } from "./lut-texture";
import { buildPostProcessUniforms } from "./post-process";
import { postProcessShader, textureCompositeShader } from "./shaders";

interface LayerEffectBuffers {
  uniforms: GPUBuffer;
  program: GPUBuffer;
  bindGroup: GPUBindGroup;
  lutTexture: GPUTexture;
  lutKey: string;
  lutBytes: number;
}

export class LayerEffectRenderer {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #sampler: GPUSampler;
  readonly #lutSampler: GPUSampler;
  readonly #identityLut: GPUTexture;
  readonly #postLayout: GPUBindGroupLayout;
  readonly #compositeLayout: GPUBindGroupLayout;
  readonly #effectPipeline: GPURenderPipeline;
  readonly #compositePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #resources = new Map<string, LayerEffectBuffers>();
  #input?: GPUTexture;
  #output?: GPUTexture;
  #depth?: GPUTexture;
  #compositeBindGroup?: GPUBindGroup;
  #width = 1;
  #height = 1;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.#device = device;
    this.#format = format;
    this.#sampler = device.createSampler({
      label: "Layer effect linear sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#lutSampler = createLutSampler(device);
    this.#identityLut = createLutTexture(device);
    this.#postLayout = device.createBindGroupLayout({
      label: "Layer effect post-process layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.#compositeLayout = device.createBindGroupLayout({
      label: "Layer effect composite layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const effectModule = device.createShaderModule({
      label: "Per-layer fused effect shader",
      code: postProcessShader,
    });
    this.#effectPipeline = device.createRenderPipeline({
      label: "Per-layer fused effect pass",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#postLayout] }),
      vertex: { module: effectModule, entryPoint: "vertex_main" },
      fragment: {
        module: effectModule,
        entryPoint: "fragment_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#compositePipelines = {
      normal: this.#createCompositePipeline("normal"),
      add: this.#createCompositePipeline("add"),
      multiply: this.#createCompositePipeline("multiply"),
      screen: this.#createCompositePipeline("screen"),
      overlay: this.#createCompositePipeline("overlay"),
    };
  }

  resize(width: number, height: number): void {
    this.#width = Math.max(1, Math.floor(width));
    this.#height = Math.max(1, Math.floor(height));
    this.#input?.destroy();
    this.#output?.destroy();
    this.#depth?.destroy();
    this.#input = this.#createTexture("Per-layer effect input");
    this.#output = this.#createTexture("Per-layer effect output");
    this.#depth = this.#device.createTexture({
      label: "Per-layer effect depth",
      size: [this.#width, this.#height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#compositeBindGroup = this.#device.createBindGroup({
      label: "Per-layer effect composite resources",
      layout: this.#compositeLayout,
      entries: [
        { binding: 0, resource: this.#output.createView() },
        { binding: 1, resource: this.#sampler },
      ],
    });
    for (const resource of this.#resources.values()) {
      resource.uniforms.destroy();
      resource.program.destroy();
      if (resource.lutTexture !== this.#identityLut) resource.lutTexture.destroy();
    }
    this.#resources.clear();
  }

  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    composition: Composition,
    layer: Layer,
    instanceId: string,
    time: number,
    drawLayer: (pass: GPURenderPassEncoder) => void,
  ): number {
    if (!this.#input || !this.#output || !this.#depth || !this.#compositeBindGroup) {
      this.resize(this.#width, this.#height);
    }
    const input = this.#input;
    const output = this.#output;
    const depth = this.#depth;
    const compositeBindGroup = this.#compositeBindGroup;
    if (!input || !output || !depth || !compositeBindGroup)
      throw new Error("Layer effect targets unavailable");

    const program = compileEffectProgram(composition, time, [layer]);
    const effects = defaultPostProcessParameters();
    const resource = this.#resource(instanceId, layer);
    this.#device.queue.writeBuffer(resource.program, 0, program.data);
    this.#device.queue.writeBuffer(
      resource.uniforms,
      0,
      buildPostProcessUniforms(this.#width, this.#height, time, effects, program.count, true),
    );

    const inputPass = encoder.beginRenderPass({
      label: `Layer source · ${layer.name}`,
      colorAttachments: [
        {
          view: input.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    drawLayer(inputPass);
    inputPass.end();

    const effectPass = encoder.beginRenderPass({
      label: `Fused layer effects · ${layer.name}`,
      colorAttachments: [
        {
          view: output.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    effectPass.setPipeline(this.#effectPipeline);
    effectPass.setBindGroup(0, resource.bindGroup);
    effectPass.draw(3);
    effectPass.end();

    const compositePass = encoder.beginRenderPass({
      label: `Layer composite · ${layer.name}`,
      colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
    });
    compositePass.setPipeline(this.#compositePipelines[layer.blendMode]);
    compositePass.setBindGroup(0, compositeBindGroup);
    compositePass.draw(3);
    compositePass.end();
    return program.count;
  }

  /**
   * Applies a composition-wide effect to the pixels already accumulated below
   * an adjustment layer. Separate ping-pong textures make every read/write
   * dependency explicit; the final copy replaces the HDR target without alpha
   * compositing the same pixels a second time.
   */
  encodeAdjustment(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    composition: Composition,
    layer: Layer,
    instanceId: string,
    time: number,
  ): number {
    if (!layer.effects.some((effect) => effect.enabled)) return 0;
    if (!this.#input || !this.#output) this.resize(this.#width, this.#height);
    const input = this.#input;
    const output = this.#output;
    if (!input || !output) throw new Error("Adjustment effect targets unavailable");

    const program = compileEffectProgram(composition, time, [layer]);
    if (program.count === 0) return 0;
    const resource = this.#resource(instanceId, layer);
    this.#device.queue.writeBuffer(resource.program, 0, program.data);
    this.#device.queue.writeBuffer(
      resource.uniforms,
      0,
      buildPostProcessUniforms(
        this.#width,
        this.#height,
        time,
        defaultPostProcessParameters(),
        program.count,
        true,
      ),
    );

    const extent: GPUExtent3DStrict = {
      width: this.#width,
      height: this.#height,
      depthOrArrayLayers: 1,
    };
    encoder.copyTextureToTexture({ texture: target }, { texture: input }, extent);
    const effectPass = encoder.beginRenderPass({
      label: `Adjustment effects · ${layer.name}`,
      colorAttachments: [
        {
          view: output.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    effectPass.setPipeline(this.#effectPipeline);
    effectPass.setBindGroup(0, resource.bindGroup);
    effectPass.draw(3);
    effectPass.end();
    encoder.copyTextureToTexture({ texture: output }, { texture: target }, extent);
    return program.count;
  }

  sweep(activeInstanceIds: Set<string>): void {
    for (const [instanceId, resource] of this.#resources) {
      if (activeInstanceIds.has(instanceId)) continue;
      resource.uniforms.destroy();
      resource.program.destroy();
      if (resource.lutTexture !== this.#identityLut) resource.lutTexture.destroy();
      this.#resources.delete(instanceId);
    }
  }

  estimatedTextureBytes(): number {
    let bytes = this.#width * this.#height * (8 * 2 + 4);
    for (const resource of this.#resources.values()) bytes += resource.lutBytes;
    return bytes;
  }

  destroy(): void {
    this.#input?.destroy();
    this.#output?.destroy();
    this.#depth?.destroy();
    this.#input = undefined;
    this.#output = undefined;
    this.#depth = undefined;
    this.#compositeBindGroup = undefined;
    for (const resource of this.#resources.values()) {
      resource.uniforms.destroy();
      resource.program.destroy();
      if (resource.lutTexture !== this.#identityLut) resource.lutTexture.destroy();
    }
    this.#resources.clear();
    this.#identityLut.destroy();
  }

  #resource(instanceId: string, layer: Layer): LayerEffectBuffers {
    const existing = this.#resources.get(instanceId);
    if (existing) {
      this.#updateLut(existing, layer);
      return existing;
    }
    if (!this.#input) throw new Error("Layer effect input is unavailable");
    const uniforms = this.#device.createBuffer({
      label: `Layer effect uniforms · ${instanceId}`,
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const program = this.#device.createBuffer({
      label: `Layer effect program · ${instanceId}`,
      size: MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const resource: LayerEffectBuffers = {
      uniforms,
      program,
      bindGroup: this.#createEffectBindGroup(instanceId, uniforms, program, this.#identityLut),
      lutTexture: this.#identityLut,
      lutKey: "identity",
      lutBytes: 0,
    };
    this.#updateLut(resource, layer);
    this.#resources.set(instanceId, resource);
    return resource;
  }

  #updateLut(resource: LayerEffectBuffers, layer: Layer): void {
    const lut = [...layer.effects]
      .reverse()
      .find((effect) => effect.enabled && effect.type === "lut" && effect.resource)?.resource;
    const key = lut ? `${lut.checksum}:${lut.size}` : "identity";
    if (resource.lutKey === key) return;
    if (resource.lutTexture !== this.#identityLut) resource.lutTexture.destroy();
    resource.lutTexture = lut ? createLutTexture(this.#device, lut) : this.#identityLut;
    resource.lutKey = key;
    resource.lutBytes = lut ? lut.size ** 3 * 8 : 0;
    resource.bindGroup = this.#createEffectBindGroup(
      layer.id,
      resource.uniforms,
      resource.program,
      resource.lutTexture,
    );
  }

  #createEffectBindGroup(
    instanceId: string,
    uniforms: GPUBuffer,
    program: GPUBuffer,
    lutTexture: GPUTexture,
  ): GPUBindGroup {
    if (!this.#input) throw new Error("Layer effect input is unavailable");
    return this.#device.createBindGroup({
      label: `Layer effect resources · ${instanceId}`,
      layout: this.#postLayout,
      entries: [
        { binding: 0, resource: this.#input.createView() },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: uniforms } },
        { binding: 3, resource: { buffer: program } },
        { binding: 4, resource: lutTexture.createView({ dimension: "3d" }) },
        { binding: 5, resource: this.#lutSampler },
      ],
    });
  }

  #createTexture(label: string): GPUTexture {
    return this.#device.createTexture({
      label,
      size: [this.#width, this.#height],
      format: this.#format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  #createCompositePipeline(blendMode: BlendMode): GPURenderPipeline {
    const module = this.#device.createShaderModule({
      label: "Layer texture composite shader",
      code: textureCompositeShader,
    });
    return this.#device.createRenderPipeline({
      label: `Per-layer ${blendMode} effect composite`,
      layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#compositeLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [{ format: this.#format, blend: gpuBlendState(blendMode) }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
}
