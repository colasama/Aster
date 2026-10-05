import { readAuxiliaryPlan } from "./auxiliary-plan";
import { canonicalJson, object, requirePlan } from "./canonical";
import { readFinalOutputPlan } from "./final-output-plan";
import { readMotionReconstructionPlan } from "./motion-reconstruction-plan";
import { readPostEffectPlan } from "./post-effect-plan";
import type { FramePlanSliceData } from "./types";

/** Data-only output stages. GPU attachments and bindings belong to the execution context. */
export interface FrameOutputPlans {
  auxiliary: FramePlanSliceData | null;
  motion: FramePlanSliceData;
  output: FramePlanSliceData;
  effect: FramePlanSliceData | null;
}

/** Validate the complete output sequence before recording any of its GPU work. */
export function validateFrameOutputPlans(input: FrameOutputPlans) {
  object(input, ["auxiliary", "motion", "output", "effect"]);
  requirePlan(
    Object.getPrototypeOf(input) === Object.prototype,
    "invalid_header",
    "Output plans must be a plain object",
  );
  for (const plan of [input.auxiliary, input.motion, input.output, input.effect]) {
    if (plan === null) continue;
    object(plan, ["metadata", "blobs"]);
    requirePlan(
      Object.getPrototypeOf(plan) === Object.prototype &&
        Array.isArray(plan.blobs) &&
        plan.blobs.every((bytes) => bytes instanceof Uint8Array),
      "invalid_header",
      "Output stages contain only metadata and numeric blobs",
    );
    canonicalJson(plan.metadata);
  }
  const final = readFinalOutputPlan(input.output),
    motion = readMotionReconstructionPlan(input.motion);
  const header = canonicalJson(final.header);
  for (const plan of [input.auxiliary, input.motion, input.effect])
    if (plan)
      requirePlan(
        canonicalJson(plan.metadata.header) === header,
        "invalid_header",
        "Output stage frame headers differ",
      );
  const auxiliary = input.auxiliary ? readAuxiliaryPlan(input.auxiliary) : undefined;
  const motionReady = motion.slice.status === "ready";
  requirePlan(
    !motionReady || !auxiliary || auxiliary.slice.status === "drawn",
    "invalid_header",
    "Motion reconstruction requires a drawn auxiliary stage",
  );
  requirePlan(
    final.route.kind !== "beauty" || final.route.source !== "motion_blur" || motionReady,
    "invalid_header",
    "Output requires skipped motion reconstruction",
  );
  const needsEffect = final.route.kind === "depth" || final.route.kind === "surface";
  requirePlan(
    needsEffect === (input.effect !== null),
    "invalid_header",
    "Output effect coverage differs from its route",
  );
  if (input.effect) {
    const effect = readPostEffectPlan(input.effect).slice.effect;
    requirePlan(
      (final.route.kind === "depth" || final.route.kind === "surface") &&
        effect.kind === final.route.kind &&
        effect.mode === final.route.mode,
      "invalid_header",
      "Output effect differs from its route",
    );
    requirePlan(
      effect.kind !== "depth" || !effect.inputs.includes("motion_blur") || motionReady,
      "invalid_header",
      "Depth effect requires skipped motion reconstruction",
    );
  }
  return { header: final.header, motionReady };
}
