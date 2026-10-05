import shaderManifest from "../../../shaders/manifest.json";
import { requirePlan } from "../frame-plan/canonical";
import { readMotionReconstructionPlan } from "../frame-plan/motion-reconstruction-plan";
import type { FramePlanSliceData } from "../frame-plan/types";
import { boundedMotionDimension, MOTION_BLUR_UNIFORM_BYTES } from "./motion-blur-uniforms";

export {
  buildMotionBlurUniforms,
  MOTION_BLUR_UNIFORM_BYTES,
  type MotionBlurFrameSettings,
} from "./motion-blur-uniforms";

import { sharedShaders } from "../gpu/shared-shader-catalog";

const TILE_SIZE = shaderManifest.programs["motion-blur"].overrides.tile_extent.default;
export interface MotionBlurTexturePlan {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  estimatedBytes: number;
}

export function planMotionBlurTextures(width: number, height: number): MotionBlurTexturePlan {
  const safeWidth = boundedMotionDimension(width);
  const safeHeight = boundedMotionDimension(height);
  const tileWidth = Math.ceil(safeWidth / TILE_SIZE);
  const tileHeight = Math.ceil(safeHeight / TILE_SIZE);
  return {
    width: safeWidth,
    height: safeHeight,
    tileWidth,
    tileHeight,
    estimatedBytes: safeWidth * safeHeight * 8 + tileWidth * tileHeight * 8 * 2,
  };
}

/**
 * GPU-only tile-max, neighbor-max, and ID-aware reconstruction in premultiplied linear HDR. The
 * output remains scene-linear so depth of field and the canonical display transform can follow it.
 */
export class MotionBlurRenderer {
  readonly #device: GPUDevice;
  readonly #tilePipeline: GPURenderPipeline;
  readonly #neighborPipeline: GPURenderPipeline;
  readonly #reconstructionPipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #output?: GPUTexture;
  #tileMax?: GPUTexture;
  #neighborMax?: GPUTexture;
  #tileBindGroup?: GPUBindGroup;
  #neighborBindGroup?: GPUBindGroup;
  #reconstructionBindGroup?: GPUBindGroup;
  #plan = planMotionBlurTextures(1, 1);

  constructor(device: GPUDevice, format: GPUTextureFormat = "rgba16float") {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Time-addressed vector motion-blur shader",
      code: motionBlurShader,
    });
    this.#tilePipeline = device.createRenderPipeline({
      label: "Motion blur tile-max pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "tile_max_fragment",
        constants: sharedShaders.pipelineConstants("motion-blur"),
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#neighborPipeline = device.createRenderPipeline({
      label: "Motion blur neighbor-max pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "neighbor_max_fragment",
        constants: sharedShaders.pipelineConstants("motion-blur"),
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#reconstructionPipeline = device.createRenderPipeline({
      label: "Motion blur ID-aware HDR reconstruction pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "reconstruct_fragment",
        constants: sharedShaders.pipelineConstants("motion-blur"),
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Motion blur HDR linear sampler",
      minFilter: "linear",
      magFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Motion blur reconstruction uniforms",
      size: MOTION_BLUR_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get outputTexture(): GPUTexture | undefined {
    return this.#output;
  }

  get estimatedBytes(): number {
    return this.#output ? this.#plan.estimatedBytes + MOTION_BLUR_UNIFORM_BYTES : 0;
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    motionVectors: GPUTexture | undefined,
    objectIds: GPUTexture | undefined,
    byteBudget = Number.POSITIVE_INFINITY,
  ): void {
    const plan = planMotionBlurTextures(width, height);
    const resized = plan.width !== this.#plan.width || plan.height !== this.#plan.height;
    this.#plan = plan;
    if (!scene || !motionVectors || !objectIds || plan.estimatedBytes > Math.max(0, byteBudget)) {
      this.#destroyTargets();
      return;
    }
    if (resized || !this.#output || !this.#tileMax || !this.#neighborMax) this.#allocateTargets();
    const output = this.#output;
    const tileMax = this.#tileMax;
    const neighborMax = this.#neighborMax;
    if (!output || !tileMax || !neighborMax) {
      this.#clearBindings();
      return;
    }
    this.#tileBindGroup = this.#device.createBindGroup({
      label: "Motion blur tile-max resources",
      layout: this.#tilePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: motionVectors.createView() },
        { binding: 1, resource: { buffer: this.#uniform } },
      ],
    });
    this.#neighborBindGroup = this.#device.createBindGroup({
      label: "Motion blur neighbor-max resources",
      layout: this.#neighborPipeline.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: tileMax.createView() }],
    });
    this.#reconstructionBindGroup = this.#device.createBindGroup({
      label: "Motion blur scene + vectors + object IDs",
      layout: this.#reconstructionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 3, resource: scene.createView() },
        { binding: 4, resource: motionVectors.createView() },
        { binding: 5, resource: objectIds.createView() },
        { binding: 6, resource: neighborMax.createView() },
        { binding: 7, resource: this.#sampler },
        { binding: 8, resource: { buffer: this.#uniform } },
      ],
    });
  }

  get ready(): boolean {
    return !!(
      this.#output &&
      this.#tileMax &&
      this.#neighborMax &&
      this.#tileBindGroup &&
      this.#neighborBindGroup &&
      this.#reconstructionBindGroup
    );
  }

  encodePlan(encoder: GPUCommandEncoder, input: FramePlanSliceData): boolean {
    const plan = readMotionReconstructionPlan(input);
    if (plan.slice.status === "skipped") return false;
    const output = this.#output;
    const tileMax = this.#tileMax;
    const neighborMax = this.#neighborMax;
    requirePlan(
      output &&
        tileMax &&
        neighborMax &&
        this.#tileBindGroup &&
        this.#neighborBindGroup &&
        this.#reconstructionBindGroup,
      "missing_resource",
      "Motion reconstruction attachments are unavailable",
    );
    requirePlan(
      this.#plan.width === plan.header.render_target.width &&
        this.#plan.height === plan.header.render_target.height,
      "resource_generation_mismatch",
      "Motion reconstruction attachment dimensions differ from the supplied plan",
    );
    this.#device.queue.writeBuffer(this.#uniform, 0, plan.uniforms);
    const tilePass = encoder.beginRenderPass({
      label: "Motion blur tile-max",
      colorAttachments: [
        {
          view: tileMax.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    tilePass.setPipeline(this.#tilePipeline);
    tilePass.setBindGroup(0, this.#tileBindGroup);
    tilePass.draw(3);
    tilePass.end();
    const neighborPass = encoder.beginRenderPass({
      label: "Motion blur neighbor-max",
      colorAttachments: [
        {
          view: neighborMax.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    neighborPass.setPipeline(this.#neighborPipeline);
    neighborPass.setBindGroup(0, this.#neighborBindGroup);
    neighborPass.draw(3);
    neighborPass.end();
    const reconstructionPass = encoder.beginRenderPass({
      label: "Motion blur ID-aware linear HDR reconstruction",
      colorAttachments: [
        {
          view: output.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    reconstructionPass.setPipeline(this.#reconstructionPipeline);
    reconstructionPass.setBindGroup(0, this.#reconstructionBindGroup);
    reconstructionPass.draw(3);
    reconstructionPass.end();
    return true;
  }

  destroy(): void {
    this.#destroyTargets();
    this.#uniform.destroy();
  }

  #allocateTargets(): void {
    this.#destroyTargets();
    this.#output = this.#device.createTexture({
      label: "Motion-blurred linear HDR scene",
      size: [this.#plan.width, this.#plan.height],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#tileMax = this.#device.createTexture({
      label: `Motion blur tile max · ${TILE_SIZE}×${TILE_SIZE}`,
      size: [this.#plan.tileWidth, this.#plan.tileHeight],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#neighborMax = this.#device.createTexture({
      label: "Motion blur neighbor max",
      size: [this.#plan.tileWidth, this.#plan.tileHeight],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  #destroyTargets(): void {
    this.#output?.destroy();
    this.#tileMax?.destroy();
    this.#neighborMax?.destroy();
    this.#output = undefined;
    this.#tileMax = undefined;
    this.#neighborMax = undefined;
    this.#clearBindings();
  }

  #clearBindings(): void {
    this.#tileBindGroup = undefined;
    this.#neighborBindGroup = undefined;
    this.#reconstructionBindGroup = undefined;
  }
}

export const motionBlurShader = sharedShaders.source("motion-blur");
