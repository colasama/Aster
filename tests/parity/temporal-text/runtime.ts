import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { createBlankProject } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import { encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { buildFrameHeader } from "../../../src/renderer/frame-plan/root-post-plan";
import type { FramePlanSliceData } from "../../../src/renderer/frame-plan/types";
import { mediaFrameMessages } from "../../../src/renderer/media/media-frame-identity";
import { MediaGpuRegistry } from "../../../src/renderer/media/media-gpu-registry";
import type { MediaResource } from "../../../src/renderer/media/media-resource";
import { captureRasterResources } from "../../../src/renderer/media/raster-resource-capture";
import {
  planTextMotionBlurFrame,
  type TextMotionBlurPlan,
} from "../../../src/renderer/text/text-motion-blur-plan";
import { TextMotionBlurRasterCache } from "../../../src/renderer/text/text-motion-blur-raster-cache";

type Mode = "full" | "enters" | "exits" | "transparent";

function fixture(mode: Mode) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.motionBlur = {
    enabled: true,
    shutterAngle: 180,
    shutterPhase: -90,
    samplesPerFrame: 8,
    adaptiveSampleLimit: 32,
  };
  const layer = createLayerForComposition("text", composition);
  layer.id = "temporal-gpu";
  layer.size = [256, 80];
  layer.text = "ASTER";
  layer.motionBlur = true;
  layer.inPoint = mode === "enters" ? 1.001 : 0;
  layer.outPoint = mode === "exits" ? 0.999 : composition.duration;
  const position = layer.textAnimator?.groups[0]?.properties.position;
  if (!position) throw new Error("Temporal fixture lacks a text animator");
  position[0] = {
    mode: "animated",
    keyframes: [
      { id: "a", time: 0, value: 0, interpolation: "linear" },
      { id: "b", time: 2, value: 120, interpolation: "linear" },
    ],
  };
  composition.layers = [layer];
  const frame = planTextMotionBlurFrame({
    composition,
    project,
    frameTime: 1,
    sceneLayers: flattenSceneLayers(composition, project, 1),
  });
  const plan: TextMotionBlurPlan | undefined =
    mode === "transparent"
      ? { frameTime: 1, sampleCount: 8, samples: [], transparentWeight: 1 }
      : [...frame.plans.values()][0];
  if (!plan || (mode !== "transparent" && plan.samples.length < 2))
    throw new Error("Temporal GPU fixture did not exercise shutter samples");
  return {
    layer,
    plan,
    header: buildFrameHeader({
      snapshot: { snapshotScope: "temporal-gpu", projectRevision: 1 },
      compositionId: composition.id,
      time: 1,
      frameRate: composition.frameRate,
      target: { width: 256, height: 80 },
      renderTarget: { width: 256, height: 80 },
      antiAliasing: "off",
    }),
  };
}

/** Runs only in the hidden G3 window, never during ordinary preview or static tests. */
export async function runTemporalTextGpuCheck() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("Temporal GPU verification requires WebGPU");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  device.pushErrorScope("validation");
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const results = [];
  try {
    for (const mode of ["full", "enters", "exits", "transparent"] as const) {
      const { layer, plan, header } = fixture(mode);
      let pass: FramePlanSliceData | undefined;
      let samples: readonly MediaResource[] = [];
      const cache = new TextMotionBlurRasterCache(device, layout, sampler, {
        capturePass: (slice, owners) => {
          pass = slice;
          samples = owners;
        },
      });
      const registry = new MediaGpuRegistry();
      let lease: ReturnType<MediaGpuRegistry["pin"]> | undefined;
      try {
        const prepared = cache.prepare(layer, "text", plan, 1);
        const messages = mediaFrameMessages(prepared.resource, "temporal-gpu");
        registry.apply(messages[0]);
        registry.apply(messages[1], prepared.resource, prepared.bindGroup);
        lease = registry.pin([messages[1].hash]);
        if (lease.bindingForHash(messages[1].hash) !== prepared.bindGroup)
          throw new Error("Temporal output does not resolve its planned hash");
        const encoder = device.createCommandEncoder();
        cache.encode(encoder, header.snapshot_scope, header);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (!pass) throw new Error("Production temporal pass was not captured");
        const capturedSamples = await captureRasterResources(
          device,
          samples,
          "temporal-gpu",
          new Map(),
          (texture) =>
            device.createBindGroup({
              layout,
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: sampler },
              ],
            }),
        );
        cache.submitted();
        const captured = await captureRasterResources(
          device,
          [prepared.resource],
          "temporal-gpu",
          new Map(),
          (texture) =>
            device.createBindGroup({
              layout,
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: sampler },
              ],
            }),
        );
        if (captured.resources.length !== 1) throw new Error("Temporal output was not captured");
        const resource = captured.resources[0];
        results.push({
          mode,
          samples: plan.samples.length,
          transparent_weight: plan.transparentWeight,
          width: prepared.resource.textureWidth,
          height: prepared.resource.textureHeight,
          messages: resource.messages,
          pixels: Array.from(new Uint8Array(resource.pixels)),
          replay: Array.from(new Uint8Array(resource.replay)),
          pass: Array.from(encodeFramePlan(pass.metadata, pass.blobs)),
          sample_resources: capturedSamples.resources.map((sample) => ({
            messages: sample.messages,
            pixels: Array.from(new Uint8Array(sample.pixels)),
            replay: Array.from(new Uint8Array(sample.replay)),
          })),
        });
      } finally {
        cache.destroy();
        lease?.release();
        registry.destroy();
      }
    }
    const scoped = await device.popErrorScope();
    if (scoped) errors.push(scoped.message);
    if (errors.length) throw new Error(errors.join("\n"));
    return {
      status: "passed",
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      results,
    };
  } finally {
    device.destroy();
  }
}
