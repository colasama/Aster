import type { TextMotionBlurFramePlan, TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import { requirePlan } from "./canonical";
import type { RootPostUniformPlanInput } from "./root-post-plan";
import { buildTemporalTextPlan, readTemporalTextPlan } from "./temporal-text-plan";
import type { FramePlanSliceData } from "./types";

export function buildTextFrameSamplePlans(
  header: RootPostUniformPlanInput,
  evaluated: TextMotionBlurFramePlan,
): FramePlanSliceData[] {
  const exposure = new Set(evaluated.exposureSceneLayers.map((scene) => scene.resourceInstanceId));
  return [...evaluated.plans].map(([id, plan]) =>
    buildTemporalTextPlan(header, id, plan, exposure.has(id)),
  );
}

/** Preparation consumes only supplied instance identities, exact samples and exposure flags. */
export function readTextFrameSamplePlans(supplied: readonly FramePlanSliceData[]) {
  const plans = new Map<string, TextMotionBlurPlan>();
  const exposureResourceIds = new Set<string>();
  for (const slice of supplied) {
    const decoded = readTemporalTextPlan(slice);
    requirePlan(
      !plans.has(decoded.resourceInstanceId),
      "invalid_temporal_text",
      "Duplicate text instance",
    );
    plans.set(decoded.resourceInstanceId, decoded.plan);
    if (decoded.exposureOnly) exposureResourceIds.add(decoded.resourceInstanceId);
  }
  return { plans, exposureResourceIds };
}
