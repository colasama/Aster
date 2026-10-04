import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { planTextMotionBlurFrame, type TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import { encodeFramePlan } from "./codec";
import type { RootPostUniformPlanInput } from "./root-post-plan";
import { buildTextFrameSamplePlans } from "./temporal-text-frame";
import { buildTemporalTextPlan, readTemporalTextPlan } from "./temporal-text-plan";

export function temporalTextFixtures() {
  const fixtures = [];
  for (const mode of ["full", "enters", "exits"] as const) {
    const project = createBlankProject();
    const composition = project.compositions[0];
    composition.id = "temporal-text-root";
    composition.motionBlur = {
      enabled: true,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 8,
      adaptiveSampleLimit: 32,
    };
    const layer = createLayerForComposition("text", composition);
    layer.id = "animated-text";
    layer.motionBlur = true;
    layer.inPoint = mode === "enters" ? 1.001 : 0;
    layer.outPoint = mode === "exits" ? 0.999 : composition.duration;
    const position = layer.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Text fixture lacks position animator");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "open", time: 0, value: 0, interpolation: "linear" },
        { id: "close", time: 2, value: 240, interpolation: "linear" },
      ],
    };
    composition.layers = [layer];
    const frame = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
    });
    const header: RootPostUniformPlanInput = {
      snapshot: { snapshotScope: "temporal-fixture", projectRevision: 1 },
      compositionId: composition.id,
      time: 1,
      frameRate: composition.frameRate,
      target: { width: 1920, height: 1080 },
      renderTarget: { width: 1920, height: 1080 },
      antiAliasing: "off",
    };
    const plans = buildTextFrameSamplePlans(header, frame);
    if (plans.length !== 1) throw new Error("Expected one temporal text fixture");
    const plan = plans[0];
    fixtures.push({
      id: `temporal-${mode}`,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
      temporal: {
        resourceInstanceId: "root/animated-text",
        exposureOnly: mode !== "full",
        plan: structuredClone(frame.plans.get("root/animated-text")),
      },
    });
    for (const source of frame.plans.values()) source.transparentWeight = 0;
    composition.layers.length = 0;
    if (mode !== "full") continue;
    for (const kind of ["transparent", "exact-bits"] as const) {
      const temporal: TextMotionBlurPlan =
        kind === "transparent"
          ? { frameTime: -0, sampleCount: 8, samples: [], transparentWeight: 1 }
          : {
              frameTime: -0,
              sampleCount: 8,
              transparentWeight: 0.25,
              samples: [
                { localTime: -0, weight: 0.25, timeBucket: -0 },
                { localTime: 1001 / 30000 + Number.EPSILON, weight: 0.5, timeBucket: 33367 },
              ],
            };
      const supplied = buildTemporalTextPlan(
        { ...header, time: -0 },
        "root/\ud800",
        temporal,
        true,
      );
      fixtures.push({
        id: `temporal-${kind}`,
        bytes: encodeFramePlan(supplied.metadata, supplied.blobs),
        temporal: readTemporalTextPlan(supplied),
      });
    }
  }
  return fixtures;
}
