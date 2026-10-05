import type { AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import type { BufferVisualization } from "../gpu/render-buffers";
import { encodeFramePlan } from "./codec";
import type { FinalOutputRoute } from "./final-output-layout";
import { buildFinalOutputPlan } from "./final-output-plan";
import { buildFrameHeader } from "./root-post-plan";

export function finalOutputFixtures() {
  const routes: [BufferVisualization, FinalOutputRoute][] = [
    ["beauty", { kind: "beauty", source: "scene" }],
    ["linearColor", { kind: "visualizer", mode: "linearColor" }],
    ["luminance", { kind: "visualizer", mode: "luminance" }],
    ["alpha", { kind: "visualizer", mode: "alpha" }],
    ["depthFog", { kind: "depth", mode: "depthFog" }],
    ["depthOfField", { kind: "depth", mode: "depthOfField" }],
    ["selectionIsolation", { kind: "surface", mode: "selectionIsolation" }],
    ["vectorMotionBlur", { kind: "surface", mode: "vectorMotionBlur" }],
    ["normal", { kind: "visualizer", mode: "normal" }],
    ["objectId", { kind: "visualizer", mode: "objectId" }],
    ["materialId", { kind: "visualizer", mode: "materialId" }],
    ["worldPosition", { kind: "visualizer", mode: "worldPosition" }],
    ["motionVector", { kind: "visualizer", mode: "motionVector" }],
  ];
  type Input = Parameters<typeof buildFinalOutputPlan>[1];
  const cases: { id: string; input: Input; route: FinalOutputRoute; aa: AntiAliasingMode }[] =
    routes.map(([mode, route]) => ({
      id: mode,
      route,
      aa: "off",
      input: {
        visualization: mode,
        auxiliaryValid: true,
        beautyDepthOfField: false,
        motionBlurValid: false,
        motionBlurBindingAvailable: false,
      },
    }));
  const add = (
    id: string,
    route: FinalOutputRoute,
    input: Partial<Input>,
    aa: AntiAliasingMode = "off",
  ) => cases.push({ id, route, aa, input: { ...cases[0].input, ...input } });
  add("beauty-depth", { kind: "depth", mode: "depthOfField" }, { beautyDepthOfField: true });
  add(
    "beauty-motion",
    { kind: "beauty", source: "motion_blur" },
    { motionBlurValid: true, motionBlurBindingAvailable: true },
  );
  add("missing-motion", { kind: "beauty", source: "scene" }, { motionBlurValid: true });
  for (const mode of ["selectionIsolation", "vectorMotionBlur"] as const)
    add(
      `missing-${mode}`,
      { kind: "beauty", source: "scene" },
      { visualization: mode, auxiliaryValid: false },
    );
  for (const aa of ["fxaa", "ssaa2x", "ssaa4x"] as const)
    add(aa, { kind: "beauty", source: "scene" }, {}, aa);
  return cases.map(({ id, route, aa, input }) => {
    const scale = aa === "ssaa4x" ? 4 : aa === "ssaa2x" ? 2 : 1;
    const plan = buildFinalOutputPlan(
      buildFrameHeader({
        snapshot: { snapshotScope: "output-fixture", projectRevision: 3 },
        compositionId: "output",
        time: 1.25,
        frameRate: { numerator: 30000, denominator: 1001 },
        target: { width: 64, height: 48 },
        renderTarget: { width: 64 * scale, height: 48 * scale },
        antiAliasing: aa,
      }),
      input,
    );
    return {
      id: `output-${id}`,
      output: { route, aa },
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
