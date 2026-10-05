import type { AntiAliasingRenderer } from "../effects/anti-aliasing";
import { requirePlan } from "../frame-plan/canonical";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import { uploadRootPostUniformPlan } from "../frame-plan/root-post-upload";
import { readRootScenePlan } from "../frame-plan/root-scene-plan";
import {
  drawSceneShadows,
  prepareSceneBuffers,
  uploadSceneBuffers,
} from "../frame-plan/scene-buffer-upload";
import type { AuxiliaryPlanBindings } from "../gpu/auxiliary-plan-bindings";
import type { MaterialGpuBindings } from "../media/material-gpu-bindings";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";
import { executeFrameOutput } from "./execute-frame-output";
import { executeRootScene } from "./execute-root-scene";

/** Record an already planned frame. Resource preparation and authoring evaluation happen upstream. */
interface FrameRecordingContext {
  encoder: GPUCommandEncoder;
  output: GPUTextureView;
  antiAliasing: AntiAliasingRenderer;
  resources: RendererResources;
  auxiliaryBindings: AuxiliaryPlanBindings;
  mediaBindings: Pick<MediaBindingLease, "bindingForHash">;
  temporalPasses?: { encode(encoder: GPUCommandEncoder): void };
  materialBindings?: Pick<MaterialGpuBindings, "bindingFor">;
}

export function recordPlannedFrame(input: FrameRecordingContext & { bundle: FrameBundle }) {
  return recordDecodedFrame({ ...input, decoded: readFrameBundle(input.bundle) });
}

/** Validated transport data can be realized independently before command recording. */
export function recordDecodedFrame(
  input: FrameRecordingContext & {
    decoded: ReturnType<typeof readFrameBundle>;
    generators?: PreparedSceneGenerator[];
  },
) {
  const { encoder, resources, mediaBindings } = input;
  const { plans, effects, generators: invocations, shadowMapSize } = input.decoded;
  const header = plans.post.metadata.header;
  requirePlan(
    resources.shadowMapSize === shadowMapSize,
    "resource_generation_mismatch",
    "Shadow allocation differs from supplied frame",
  );
  const sceneBuffers = prepareSceneBuffers(plans.scene),
    root = readRootScenePlan(plans.root);
  const generators =
    input.generators ??
    invocations.map((plan) => {
      const prepared = resources.sceneGenerators.preparePlan(plan);
      requirePlan(
        prepared.effectiveCount === plan.effectiveCount,
        "resource_generation_mismatch",
        "Captured root generator workload cannot be reproduced",
      );
      return prepared;
    });
  const generatorMap = new Map(generators.map((generator) => [generator.instanceId, generator]));
  uploadSceneBuffers(sceneBuffers, {
    queue: resources.device.queue,
    lightingBuffer: resources.lightingBuffer,
    get shapeBuffer() {
      return resources.shapeBuffer;
    },
    ensureShapeBuffer: (bytes) => resources.ensureShapeBuffer(bytes),
  });
  uploadRootPostUniformPlan(plans.post, {
    queue: resources.device.queue,
    buffer: resources.postUniformBuffer,
    target: header.target,
    renderTarget: header.render_target,
    antiAliasing: header.aa,
  });
  resources.mediaTextures.flush(
    encoder,
    plans.post.metadata.header,
    input.temporalPasses ? [] : plans.temporal,
  );
  input.temporalPasses?.encode(encoder);
  resources.precompositionSurfaces.encode(encoder, plans.precompositions, mediaBindings);
  const compute = encoder.beginComputePass({
    label: generators.some((generator) => generator.lodApplied)
      ? "Scene generators · bounded LOD"
      : "Scene generators",
    timestampWrites: resources.gpuProfiler.writes(0, 1),
  });
  for (const generator of generators) resources.sceneGenerators.encodeCompute(compute, generator);
  compute.end();
  if (sceneBuffers.slice.shadows_enabled) {
    const shadowPass = encoder.beginRenderPass({
      label: `Scene shadow-map depth · ${resources.shadowMapSize}²`,
      timestampWrites: resources.gpuProfiler.writes(2, 3),
      colorAttachments: [],
      depthStencilAttachment: {
        view: resources.shadowTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    shadowPass.setPipeline(resources.shadowPipeline);
    shadowPass.setBindGroup(0, resources.shadowBindGroup);
    shadowPass.setVertexBuffer(0, resources.shapeBuffer);
    drawSceneShadows(sceneBuffers, shadowPass);
    shadowPass.end();
  } else {
    const shadowMarker = encoder.beginComputePass({
      label: "Shadow raster disabled",
      timestampWrites: resources.gpuProfiler.writes(2, 3),
    });
    shadowMarker.end();
  }
  const sceneTexture = resources.sceneTexture;
  const sceneView = sceneTexture?.createView();
  const depthView = resources.depthTexture?.createView();
  if (!sceneTexture || !sceneView || !depthView || !resources.postBindGroup)
    throw new Error("HDR scene target is unavailable");
  const result = executeRootScene({
    commands: root.commands,
    draws: root.draws,
    effects,
    generators: generatorMap,
    mediaBindings,
    materialBindings: input.materialBindings,
    resources,
    encoder,
    sceneTexture,
    sceneView,
    depthView,
  });
  resources.layerEffects.sweep(result.activeEffectInstances);
  const { motionReady } = executeFrameOutput({
    plans: plans.output,
    encoder,
    output: input.output,
    antiAliasing: input.antiAliasing,
    resources,
    auxiliary: {
      renderer: resources.auxiliaryBuffers,
      vertexBuffer: resources.shapeBuffer,
      bindings: input.auxiliaryBindings,
    },
    sceneView,
  });
  return { ...result, beautyMotionBlurValid: motionReady };
}
