import { requirePlan } from "../frame-plan/canonical";
import { readTemporalPassSlice } from "../frame-plan/temporal-pass-plan";
import type { FramePlanSliceData } from "../frame-plan/types";
import type { SuppliedMediaPixels } from "../media/supplied-media-pixels";
import { TemporalTextPipelines } from "./temporal-text-pipelines";
import {
  executeTemporalTextPassPlan,
  type TemporalTextPassDestination,
  type TemporalTextPassPlan,
} from "./text-motion-blur-pass-plan";
import { TEXT_MOTION_BLUR_WEIGHT_STRIDE } from "./text-motion-blur-raster-input";

/** Rebuild temporal outputs from captured samples; resolved output pixels are never uploaded. */
export class SuppliedTemporalTextPasses {
  readonly #textures: GPUTexture[] = [];
  readonly #buffers: GPUBuffer[] = [];
  readonly #passes: {
    plan: TemporalTextPassPlan;
    destination: TemporalTextPassDestination;
    bindings: Map<string, GPUBindGroup>;
  }[] = [];
  #destroyed = false;

  constructor(
    slices: readonly FramePlanSliceData[],
    device: GPUDevice,
    sampler: GPUSampler,
    media: SuppliedMediaPixels,
  ) {
    const plans = slices.map(readTemporalPassSlice);
    const bytes = plans.reduce(
      (total, p) =>
        total + p.width * p.height * 8 + p.samples.length * TEXT_MOTION_BLUR_WEIGHT_STRIDE,
      0,
    );
    requirePlan(
      bytes <= 384 * 1024 * 1024,
      "resource_budget_exceeded",
      "Supplied temporal accumulation exceeds budget",
    );
    if (plans.length === 0) return;
    try {
      const pipelines = new TemporalTextPipelines(device);
      for (const plan of plans) {
        const output = media.textureForHash(plan.output),
          outputBinding = media.bindingForHash(plan.output);
        requirePlan(
          outputBinding &&
            output.width === plan.width &&
            output.height === plan.height &&
            output.format === plan.output_format,
          "resource_generation_mismatch",
          "Supplied temporal output differs",
        );
        const accumulation = device.createTexture({
          label: "Supplied temporal accumulation",
          size: [plan.width, plan.height],
          format: plan.accumulation_format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.#textures.push(accumulation);
        const weights = plan.samples.length
          ? device.createBuffer({
              label: "Supplied temporal weights",
              size: plan.samples.length * TEXT_MOTION_BLUR_WEIGHT_STRIDE,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
          : undefined;
        if (weights) this.#buffers.push(weights);
        const bindings = new Map([[plan.output, outputBinding]]);
        for (const [index, sample] of plan.samples.entries()) {
          const texture = media.textureForHash(sample.hash);
          requirePlan(
            weights &&
              texture.width === plan.width &&
              texture.height === plan.height &&
              texture.format === plan.sample_format,
            "resource_generation_mismatch",
            "Supplied temporal sample differs",
          );
          bindings.set(
            sample.hash,
            device.createBindGroup({
              layout: pipelines.sampleLayout,
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: sampler },
                {
                  binding: 2,
                  resource: {
                    buffer: weights,
                    offset: index * TEXT_MOTION_BLUR_WEIGHT_STRIDE,
                    size: 16,
                  },
                },
              ],
            }),
          );
        }
        const resolveBinding = device.createBindGroup({
          layout: pipelines.resolveLayout,
          entries: [{ binding: 0, resource: accumulation.createView() }],
        });
        this.#passes.push({
          plan,
          bindings,
          destination: {
            queue: device.queue,
            width: plan.width,
            height: plan.height,
            output,
            outputBinding,
            accumulation,
            weights,
            resolveBinding,
            accumulatePipeline: pipelines.accumulatePipeline,
            resolvePipeline: pipelines.resolvePipeline,
          },
        });
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  encode(encoder: GPUCommandEncoder): void {
    requirePlan(!this.#destroyed, "missing_resource", "Supplied temporal passes were destroyed");
    for (const { plan, destination, bindings } of this.#passes)
      executeTemporalTextPassPlan(
        plan,
        {
          hashFor: (id) =>
            id === "output"
              ? plan.output
              : (plan.samples[Number(id.slice("sample:".length))]?.hash ?? null),
          bindingForHash: (hash) => bindings.get(String(hash)),
        },
        encoder,
        destination,
      );
  }

  destroy(): void {
    this.#destroyed = true;
    for (const texture of this.#textures) texture.destroy();
    for (const buffer of this.#buffers) buffer.destroy();
    this.#textures.length = this.#buffers.length = this.#passes.length = 0;
  }
}
