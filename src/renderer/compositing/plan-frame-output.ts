import type { MotionBlurInterval } from "../../core/animation/motion-blur";
import type { MotionBlurSettings } from "../../core/types";
import { selectedRenderId } from "../effects/surface-post-effects";
import { readAuxiliaryPlan } from "../frame-plan/auxiliary-plan";
import { compositionIdentityFromString } from "../frame-plan/composition-identity";
import { buildFinalOutputPlan, readFinalOutputPlan } from "../frame-plan/final-output-plan";
import { type FrameOutputPlans, validateFrameOutputPlans } from "../frame-plan/frame-output-plans";
import {
  buildMotionReconstructionPlan,
  readMotionReconstructionPlan,
} from "../frame-plan/motion-reconstruction-plan";
import type { PreparedSceneBuffers } from "../frame-plan/scene-buffer-upload";
import type { FrameHeaderSlice } from "../frame-plan/types";
import type { GeometryBatch } from "../geometry/geometry";
import { type BufferVisualization, usesAuxiliarySurfaceData } from "../gpu/render-buffers";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { RendererResources } from "../renderer-resources";
import type { PreparedSceneGenerator } from "../scene/scene-generator-host";

/** Resolve authoring and observed resource decisions before recording commands. */
export function planFrameOutput(input: {
  header: FrameHeaderSlice;
  resources: RendererResources;
  sceneBuffers: PreparedSceneBuffers;
  sceneBatches: readonly GeometryBatch[];
  sceneGenerators: readonly PreparedSceneGenerator[];
  mediaBindings: MediaBindingLease;
  visualization: BufferVisualization;
  beautyDepthOfField: boolean;
  beautyMotionBlur: boolean;
  motionBlurRequested: boolean;
  motionBlurSettings: MotionBlurSettings;
  shutterInterval: MotionBlurInterval;
  compositionWidth: number;
  selectedLayerId?: string;
}) {
  const {
    header,
    resources,
    sceneBuffers,
    sceneBatches,
    sceneGenerators,
    mediaBindings,
    visualization,
    beautyDepthOfField,
    beautyMotionBlur,
    motionBlurRequested,
    motionBlurSettings,
    shutterInterval,
    compositionWidth,
    selectedLayerId,
  } = input;
  const needsAuxiliarySurfaceData =
    usesAuxiliarySurfaceData(visualization) || beautyDepthOfField || motionBlurRequested;
  let auxiliaryFrameValid = !needsAuxiliarySurfaceData;
  let auxiliary: ReturnType<RendererResources["auxiliaryBuffers"]["buildPlan"]> | undefined;
  if (!auxiliaryFrameValid) {
    auxiliary = resources.auxiliaryBuffers.buildPlan({
      header: header,
      vertexCount: sceneBuffers.slice.vertex_count,
      batches: sceneBatches,
      motionVectors: sceneBuffers.motionVectors,
      mediaBinding: (batch) => {
        const surface = resources.precompositionSurfaces.bindingFor(batch.instanceId);
        if (surface)
          return {
            texture: {
              kind: "surface",
              instance_id: compositionIdentityFromString(batch.instanceId),
            },
            binding: surface,
          };
        if (
          batch.layer.kind === "image" ||
          batch.layer.kind === "video" ||
          batch.mediaResourceHash !== undefined
        ) {
          const binding = mediaBindings.bindingForHash(batch.mediaResourceHash);
          return binding && batch.mediaResourceHash
            ? { texture: { kind: "media", hash: batch.mediaResourceHash }, binding }
            : undefined;
        }
        return undefined;
      },
      generators: beautyMotionBlur
        ? []
        : sceneGenerators.flatMap((generator) => {
            const draw = resources.sceneGenerators.auxiliaryDraw(generator);
            return draw ? [{ instanceId: generator.instanceId, draw }] : [];
          }),
    });
    auxiliaryFrameValid = readAuxiliaryPlan(auxiliary.plan).slice.status === "drawn";
  }
  const motionPlan = buildMotionReconstructionPlan(header, {
    requested: beautyMotionBlur && auxiliaryFrameValid && sceneBuffers.motionVectors !== undefined,
    resourcesAvailable: resources.motionBlur.ready,
    settings: motionBlurSettings,
    shutter: shutterInterval,
    compositionWidth: compositionWidth,
  });
  const beautyMotionBlurValid = readMotionReconstructionPlan(motionPlan).slice.status === "ready";
  if (beautyDepthOfField) {
    resources.depthEffects.setSources(
      header.render_target.width,
      header.render_target.height,
      beautyMotionBlurValid ? resources.motionBlur.outputTexture : resources.sceneTexture,
      resources.auxiliaryBuffers.textures.get("worldPosition"),
      resources.auxiliaryBuffers.transparentWorldPosition,
      resources.auxiliaryBuffers.peeledWorldPosition,
      resources.auxiliaryBuffers.frontLayerColor,
      resources.auxiliaryBuffers.peeledLayerColor,
      beautyMotionBlurValid ? "motion_blur" : "scene",
    );
  }
  resources.surfacePostEffects.setSelection(
    selectedRenderId(
      sceneBatches,
      selectedLayerId,
      sceneGenerators.map((generator) => generator.selectionId),
    ),
  );
  resources.surfacePostEffects.setMotionShutterScale(
    auxiliary && readAuxiliaryPlan(auxiliary.plan).slice.motion ? 1 : 0,
  );
  const outputPlan = buildFinalOutputPlan(header, {
    visualization: visualization,
    auxiliaryValid: auxiliaryFrameValid,
    beautyDepthOfField,
    motionBlurValid: beautyMotionBlurValid,
    motionBlurBindingAvailable: Boolean(resources.motionBlurPostBindGroup),
  });
  const { route: outputRoute } = readFinalOutputPlan(outputPlan);
  const postEffectPlan =
    outputRoute.kind === "depth"
      ? resources.depthEffects.buildPlan(header, outputRoute.mode)
      : outputRoute.kind === "surface"
        ? resources.surfacePostEffects.buildPlan(header, outputRoute.mode)
        : undefined;
  const plans: FrameOutputPlans = {
    auxiliary: auxiliary?.plan ?? null,
    motion: motionPlan,
    output: outputPlan,
    effect: postEffectPlan ?? null,
  };
  validateFrameOutputPlans(plans);
  return {
    plans,
    auxiliaryBindings: auxiliary?.bindings ?? { media: new Map(), generators: new Map() },
  };
}
