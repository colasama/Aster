import type { AntiAliasingRenderer } from "../../../src/renderer/effects/anti-aliasing";
import {
  type BufferVisualization,
  isDepthEffectVisualization,
  isSurfaceEffectVisualization,
  postRenderRoute,
} from "../../../src/renderer/gpu/render-buffers";
import type { outputResources } from "./draw";
import type { LegacyDepthEffectsRenderer } from "./legacy-depth";
import type { LegacySurfacePostEffectsRenderer } from "./legacy-surface";
export function legacyOutput(
  encoder: GPUCommandEncoder,
  output: GPUTextureView,
  antiAliasing: AntiAliasingRenderer,
  resources: {
    postPipeline: GPURenderPipeline;
    postBindGroup: GPUBindGroup;
    motionBlurPostBindGroup?: GPUBindGroup;
    depthEffects: LegacyDepthEffectsRenderer;
    surfacePostEffects: LegacySurfacePostEffectsRenderer;
    bufferVisualizer: ReturnType<typeof outputResources>["visualizer"];
    gpuProfiler: ReturnType<typeof outputResources>["profiler"];
  },
  bufferVisualization: BufferVisualization,
  activeAntiAliasing: Parameters<AntiAliasingRenderer["resize"]>[0],
  beautyMotionBlurValid: boolean,
  auxiliaryFrameValid = true,
  beautyDepthOfField = false,
) {
  const postPass = encoder.beginRenderPass({
    label: "Fused effects + sRGB display transform",
    timestampWrites: resources.gpuProfiler.writes(6, activeAntiAliasing === "off" ? 7 : undefined),
    colorAttachments: [
      {
        view: antiAliasing.view ?? output,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  const postRoute = postRenderRoute(bufferVisualization, auxiliaryFrameValid);
  const beautyPostBindGroup =
    beautyMotionBlurValid && resources.motionBlurPostBindGroup
      ? resources.motionBlurPostBindGroup
      : resources.postBindGroup;
  if (beautyDepthOfField && auxiliaryFrameValid) {
    resources.depthEffects.encode(postPass, "depthOfField");
  } else if (postRoute === "beauty") {
    postPass.setPipeline(resources.postPipeline);
    postPass.setBindGroup(0, beautyPostBindGroup);
    postPass.draw(3);
  } else if (isDepthEffectVisualization(bufferVisualization)) {
    resources.depthEffects.encode(postPass, bufferVisualization);
  } else if (isSurfaceEffectVisualization(bufferVisualization)) {
    resources.surfacePostEffects.encode(postPass, bufferVisualization);
  } else if (bufferVisualization === "beauty") {
    postPass.setPipeline(resources.postPipeline);
    postPass.setBindGroup(0, beautyPostBindGroup);
    postPass.draw(3);
  } else resources.bufferVisualizer.encode(postPass, bufferVisualization);
  postPass.end();
  antiAliasing.encode(encoder, output, resources.gpuProfiler.writes(undefined, 7));
}
