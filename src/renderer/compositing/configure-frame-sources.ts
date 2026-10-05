import type { GpuDiagnostics } from "../../core/types";
import type { BufferVisualization } from "../gpu/render-buffers";
import type { RendererResources } from "../renderer-resources";

/** Connect resident auxiliary textures to the output stages after target allocation. */
export function configureFrameSources(
  resources: RendererResources,
  width: number,
  height: number,
  motionBlur: boolean,
  memoryBudgetMb: number | undefined,
  depthOfField: boolean,
  visualization: BufferVisualization,
  diagnostics: GpuDiagnostics,
): BufferVisualization {
  const mode = resources.auxiliaryBuffers.configureVisualization(
    resources.bufferVisualizer,
    visualization,
    width,
    height,
    memoryBudgetMb,
    depthOfField || motionBlur,
    depthOfField,
  );
  diagnostics.depthOfFieldTier = resources.auxiliaryBuffers.depthOfFieldTier;
  diagnostics.depthOfFieldDegradedReason = resources.auxiliaryBuffers.depthOfFieldDiagnostic;
  resources.motionBlur.setSources(
    width,
    height,
    motionBlur ? resources.sceneTexture : undefined,
    motionBlur ? resources.auxiliaryBuffers.textures.get("motionVector") : undefined,
    motionBlur ? resources.auxiliaryBuffers.textures.get("objectId") : undefined,
    (memoryBudgetMb ?? 512) * 1024 * 1024 * 0.25,
  );
  resources.motionBlurPostBindGroup = resources.motionBlur.outputTexture
    ? resources.createPostBindGroup(resources.motionBlur.outputTexture, "motion-blurred scene")
    : undefined;
  resources.depthEffects.setSources(
    width,
    height,
    resources.sceneTexture,
    resources.auxiliaryBuffers.textures.get("worldPosition"),
    resources.auxiliaryBuffers.transparentWorldPosition,
    resources.auxiliaryBuffers.peeledWorldPosition,
    resources.auxiliaryBuffers.frontLayerColor,
    resources.auxiliaryBuffers.peeledLayerColor,
  );
  resources.surfacePostEffects.setSources(
    width,
    height,
    resources.sceneTexture,
    resources.auxiliaryBuffers.textures.get("objectId"),
    resources.auxiliaryBuffers.textures.get("motionVector"),
  );
  return mode;
}
