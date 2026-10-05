import type { AntiAliasingRenderer } from "../effects/anti-aliasing";
import { requirePlan } from "../frame-plan/canonical";
import { readFinalOutputPlan } from "../frame-plan/final-output-plan";
import type { FramePlanSliceData } from "../frame-plan/types";
import type { RendererResources } from "../renderer-resources";

/** The output route and AA mode are supplied; this boundary reads no authoring or view settings. */
export function executeFinalOutput(input: {
  plan: FramePlanSliceData;
  encoder: GPUCommandEncoder;
  output: GPUTextureView;
  antiAliasing: Pick<AntiAliasingRenderer, "plannedView" | "encode">;
  resources: Pick<
    RendererResources,
    | "postPipeline"
    | "postBindGroup"
    | "motionBlurPostBindGroup"
    | "depthEffects"
    | "surfacePostEffects"
    | "bufferVisualizer"
    | "gpuProfiler"
  >;
}): void {
  const { header, route, clear } = readFinalOutputPlan(input.plan);
  const { encoder, output, antiAliasing, resources } = input;
  const target =
    antiAliasing.plannedView(header.aa, header.render_target.width, header.render_target.height) ??
    output;
  const beauty =
    route.kind === "beauty" && route.source === "motion_blur"
      ? resources.motionBlurPostBindGroup
      : resources.postBindGroup;
  requirePlan(
    route.kind !== "beauty" || beauty,
    "missing_resource",
    "Planned beauty source is absent",
  );
  const pass = encoder.beginRenderPass({
    label: "Fused effects + sRGB display transform",
    timestampWrites: resources.gpuProfiler.writes(6, header.aa === "off" ? 7 : undefined),
    colorAttachments: [{ view: target, clearValue: clear, loadOp: "clear", storeOp: "store" }],
  });
  switch (route.kind) {
    case "beauty":
      pass.setPipeline(resources.postPipeline);
      pass.setBindGroup(0, beauty);
      pass.draw(3);
      break;
    case "depth":
      resources.depthEffects.encode(pass, route.mode);
      break;
    case "surface":
      resources.surfacePostEffects.encode(pass, route.mode);
      break;
    case "visualizer":
      resources.bufferVisualizer.encode(pass, route.mode);
      break;
  }
  pass.end();
  antiAliasing.encode(encoder, output, resources.gpuProfiler.writes(undefined, 7));
}
