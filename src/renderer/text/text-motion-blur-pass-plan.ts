import { hash, integer, object, requirePlan } from "../frame-plan/canonical";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { TEXT_MOTION_BLUR_WEIGHT_STRIDE } from "./text-motion-blur-raster-input";

export interface TemporalTextPassPlan {
  kind: "temporal_text_passes";
  width: number;
  height: number;
  output: string;
  samples: { hash: string; weight: number }[];
  sample_format: "rgba8unorm-srgb";
  accumulation_format: "rgba16float";
  output_format: "rgba8unorm-srgb";
}

export function validateTemporalTextPassPlan(value: unknown): TemporalTextPassPlan {
  const plan = object(value, [
    "kind",
    "width",
    "height",
    "output",
    "samples",
    "sample_format",
    "accumulation_format",
    "output_format",
  ]);
  requirePlan(
    plan.kind === "temporal_text_passes" &&
      plan.sample_format === "rgba8unorm-srgb" &&
      plan.accumulation_format === "rgba16float" &&
      plan.output_format === "rgba8unorm-srgb",
    "invalid_temporal_text",
    "Temporal pass formats differ",
  );
  integer(plan.width, 1, 8192);
  integer(plan.height, 1, 8192);
  hash(plan.output);
  requirePlan(
    Array.isArray(plan.samples) && plan.samples.length <= 4096,
    "invalid_temporal_text",
    "Temporal pass samples exceed their bound",
  );
  const hashes = new Set<string>([String(plan.output)]);
  let total = 0;
  for (const value of plan.samples) {
    const sample = object(value, ["hash", "weight"]);
    hash(sample.hash);
    const id = String(sample.hash);
    requirePlan(
      !hashes.has(id),
      "invalid_temporal_text",
      "Temporal pass resources must be distinct",
    );
    hashes.add(id);
    requirePlan(
      typeof sample.weight === "number" &&
        Number.isFinite(sample.weight) &&
        sample.weight >= 0 &&
        sample.weight <= 1,
      "invalid_temporal_text",
      "Invalid temporal pass weight",
    );
    total += sample.weight;
  }
  requirePlan(
    total <= 1 + Number.EPSILON * (plan.samples.length + 1) * 4,
    "invalid_temporal_text",
    "Temporal pass weights exceed one exposure",
  );
  return structuredClone(plan) as unknown as TemporalTextPassPlan;
}

export function buildTemporalTextPassPlan(
  width: number,
  height: number,
  weights: readonly number[],
  resources: Pick<MediaBindingLease, "hashFor">,
): TemporalTextPassPlan {
  return validateTemporalTextPassPlan({
    kind: "temporal_text_passes",
    width,
    height,
    output: resources.hashFor("output"),
    samples: weights.map((weight, index) => ({
      hash: resources.hashFor(`sample:${index}`),
      weight,
    })),
    sample_format: "rgba8unorm-srgb",
    accumulation_format: "rgba16float",
    output_format: "rgba8unorm-srgb",
  });
}

export interface TemporalTextPassDestination {
  queue: GPUQueue;
  width: number;
  height: number;
  output: GPUTexture;
  outputBinding: GPUBindGroup;
  accumulation: GPUTexture;
  weights?: GPUBuffer;
  resolveBinding: GPUBindGroup;
  accumulatePipeline: GPURenderPipeline;
  resolvePipeline: GPURenderPipeline;
}

/** Resolves every supplied hash and weight before encoding either temporal pass. */
export function executeTemporalTextPassPlan(
  value: TemporalTextPassPlan,
  resources: Pick<MediaBindingLease, "hashFor" | "bindingForHash">,
  encoder: GPUCommandEncoder,
  destination: TemporalTextPassDestination,
): void {
  const plan = validateTemporalTextPassPlan(value);
  requirePlan(
    plan.width === destination.width && plan.height === destination.height,
    "invalid_temporal_text",
    "Temporal pass extent differs from its allocation",
  );
  requirePlan(
    resources.bindingForHash(plan.output) === destination.outputBinding,
    "resource_generation_mismatch",
    "Temporal output allocation differs from its planned hash",
  );
  const bindings = plan.samples.map((sample, index) => {
    requirePlan(
      resources.hashFor(`sample:${index}`) === sample.hash,
      "resource_generation_mismatch",
      "Temporal sample uniform slot differs from its planned hash",
    );
    const binding = resources.bindingForHash(sample.hash);
    requirePlan(binding, "missing_resource", "Temporal sample binding is absent");
    return binding;
  });
  const stride = TEXT_MOTION_BLUR_WEIGHT_STRIDE;
  requirePlan(
    plan.samples.length === 0 ||
      (destination.weights !== undefined &&
        destination.weights.size === plan.samples.length * stride),
    "invalid_temporal_text",
    "Temporal weight buffer size differs",
  );
  if (plan.samples.length > 0 && destination.weights) {
    const data = new Float32Array((plan.samples.length * stride) / 4);
    plan.samples.forEach((sample, index) => {
      data[(index * stride) / 4] = sample.weight;
    });
    destination.queue.writeBuffer(destination.weights, 0, data);
  }
  const accumulation = encoder.beginRenderPass({
    label: "Temporal text premultiplied linear accumulation",
    colorAttachments: [
      {
        view: destination.accumulation.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  accumulation.setPipeline(destination.accumulatePipeline);
  for (const binding of bindings) {
    accumulation.setBindGroup(0, binding);
    accumulation.draw(3);
  }
  accumulation.end();
  const resolve = encoder.beginRenderPass({
    label: "Temporal text straight-alpha sRGB resolve",
    colorAttachments: [
      {
        view: destination.output.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  resolve.setPipeline(destination.resolvePipeline);
  resolve.setBindGroup(0, destination.resolveBinding);
  resolve.draw(3);
  resolve.end();
}
