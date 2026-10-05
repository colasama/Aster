import type { AntiAliasingRenderer } from "../effects/anti-aliasing";
import { requirePlan } from "../frame-plan/canonical";
import { type FrameOutputPlans, validateFrameOutputPlans } from "../frame-plan/frame-output-plans";
import type { AuxiliaryPlanBindings } from "../gpu/auxiliary-plan-bindings";
import type { RendererResources } from "../renderer-resources";
import { executeFinalOutput } from "./execute-final-output";

export function executeFrameOutput(input: {
  plans: FrameOutputPlans;
  encoder: GPUCommandEncoder;
  output: GPUTextureView;
  antiAliasing: Pick<AntiAliasingRenderer, "plannedView" | "encode">;
  resources: Parameters<typeof executeFinalOutput>[0]["resources"] &
    Pick<RendererResources, "motionBlur">;
  auxiliary?: {
    renderer: RendererResources["auxiliaryBuffers"];
    vertexBuffer: GPUBuffer;
    bindings: AuxiliaryPlanBindings;
  };
  sceneView?: GPUTextureView;
}) {
  const { motionReady } = validateFrameOutputPlans(input.plans);
  const { plans, resources, encoder } = input;
  if (plans.auxiliary) {
    requirePlan(input.auxiliary, "missing_resource", "Missing auxiliary execution context");
    input.auxiliary.renderer.encodePlan(
      encoder,
      plans.auxiliary,
      input.auxiliary.vertexBuffer,
      input.auxiliary.bindings,
    );
  }
  resources.motionBlur.encodePlan(encoder, plans.motion);
  if (input.sceneView)
    encoder
      .beginRenderPass({
        label: "Composition timing marker",
        timestampWrites: resources.gpuProfiler.writes(undefined, 5),
        colorAttachments: [{ view: input.sceneView, loadOp: "load", storeOp: "store" }],
      })
      .end();
  executeFinalOutput({
    plan: plans.output,
    postEffectPlan: plans.effect ?? undefined,
    encoder,
    output: input.output,
    antiAliasing: input.antiAliasing,
    resources,
  });
  return { motionReady };
}
