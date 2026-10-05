import { requirePlan } from "../frame-plan/canonical";
import { buildPostEffectPlan, readPostEffectPlan } from "../frame-plan/post-effect-plan";
import type { FrameHeaderSlice, FramePlanSliceData } from "../frame-plan/types";
import type { GeometryBatch } from "../geometry/geometry";
import { encodeRenderId, type SurfaceEffectVisualization } from "../gpu/render-buffers";
import { sharedShaders } from "../gpu/shared-shader-catalog";

export const SURFACE_POST_UNIFORM_BYTES = 32;

const MODE_CODES: Readonly<Record<SurfaceEffectVisualization, number>> = {
  selectionIsolation: 1,
  vectorMotionBlur: 2,
};

/** The object MRT stores root selection IDs, so every clone shares this one stable hash. */
export function selectedRenderId(
  batches: readonly Pick<GeometryBatch, "selectionId">[],
  selectedLayerId: string | undefined,
  generatorSelectionIds: readonly string[] | string = [],
): number {
  if (!selectedLayerId) return 0;
  const generatorIds =
    typeof generatorSelectionIds === "string" ? [generatorSelectionIds] : generatorSelectionIds;
  const visible =
    generatorIds.includes(selectedLayerId) ||
    batches.some((batch) => batch.selectionId === selectedLayerId);
  return visible ? encodeRenderId(selectedLayerId) : 0;
}

/** Packs viewport, mode, selected root ID, and normalized shutter scale into two vec4 slots. */
export function buildSurfacePostUniforms(
  mode: SurfaceEffectVisualization,
  width: number,
  height: number,
  renderId: number,
  motionShutterScale: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(SURFACE_POST_UNIFORM_BYTES);
  new Float32Array(buffer, 0, 2).set([boundedDimension(width), boundedDimension(height)]);
  new Uint32Array(buffer, 8, 2).set([
    MODE_CODES[mode],
    Number.isInteger(renderId) && renderId > 0 ? renderId : 0,
  ]);
  new Float32Array(buffer, 16, 4).set([bounded(motionShutterScale, 0, 4), 0, 0, 0]);
  return buffer;
}

/** Real HDR post effects driven by the object-ID and motion-vector MRT attachments. */
export class SurfacePostEffectsRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #bindGroup?: GPUBindGroup;
  #width = 1;
  #height = 1;
  #selectedRenderId = 0;
  #motionShutterScale = 0;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Object-ID isolation and vector motion-blur shader",
      code: surfacePostEffectsShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Object-ID isolation and vector motion-blur pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Surface post-effect HDR sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Surface post-effect uniforms",
      size: SURFACE_POST_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get estimatedBytes(): number {
    return SURFACE_POST_UNIFORM_BYTES;
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    objectIds: GPUTexture | undefined,
    motionVectors: GPUTexture | undefined,
  ): void {
    this.#width = boundedDimension(width);
    this.#height = boundedDimension(height);
    this.#bindGroup =
      scene && objectIds && motionVectors
        ? this.#device.createBindGroup({
            label: "HDR + Object ID + Motion Vector post resources",
            layout: this.#pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: scene.createView() },
              { binding: 1, resource: this.#sampler },
              { binding: 2, resource: objectIds.createView() },
              { binding: 3, resource: motionVectors.createView() },
              { binding: 4, resource: { buffer: this.#uniform } },
            ],
          })
        : undefined;
  }

  setSelection(renderId: number): void {
    this.#selectedRenderId = renderId;
  }

  setMotionShutterScale(scale: number): void {
    this.#motionShutterScale = scale;
  }

  buildPlan(header: FrameHeaderSlice, mode: SurfaceEffectVisualization): FramePlanSliceData {
    return buildPostEffectPlan(
      header,
      { kind: "surface", mode, inputs: ["scene", "objectId", "motionVector"] },
      Boolean(this.#bindGroup),
      new Uint8Array(
        buildSurfacePostUniforms(
          mode,
          header.render_target.width,
          header.render_target.height,
          this.#selectedRenderId,
          this.#motionShutterScale,
        ),
      ),
    );
  }

  preparePlan(input: FramePlanSliceData): (pass: GPURenderPassEncoder) => boolean {
    const plan = readPostEffectPlan(input);
    requirePlan(
      plan.slice.effect.kind === "surface",
      "invalid_header",
      "Expected surface effect plan",
    );
    if (plan.slice.status === "skipped") return () => false;
    requirePlan(
      this.#width === plan.header.render_target.width &&
        this.#height === plan.header.render_target.height,
      "resource_generation_mismatch",
      "Surface attachment dimensions differ from the plan",
    );
    const bindGroup = this.#bindGroup;
    requirePlan(bindGroup, "missing_resource", "Missing planned surface attachments");
    this.#device.queue.writeBuffer(this.#uniform, 0, plan.uniforms);
    return (pass) => {
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      return true;
    };
  }

  destroy(): void {
    this.#bindGroup = undefined;
    this.#uniform.destroy();
  }
}

function boundedDimension(value: number): number {
  return Math.min(16_384, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export const surfacePostEffectsShader = sharedShaders.source("surface-post-effects");
