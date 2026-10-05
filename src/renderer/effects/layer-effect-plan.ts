import type { Composition, Layer } from "../../core/types";
import { requirePlan } from "../frame-plan/canonical";
import { buildLayerEffectSlice, readLayerEffectSlice } from "../frame-plan/layer-effect-plan";
import type { FrameHeaderSlice, FramePlanSliceData } from "../frame-plan/types";
import {
  type LutSelection,
  type LutSelectionPlanner,
  suppliedLutResource,
} from "../media/lut-selection-plan";
import { defaultPostProcessParameters } from "./effect-parameters";
import { compileEffectProgram } from "./effect-program";
import { buildPostProcessUniforms } from "./post-process";

export type PreparedLayerEffect =
  | { status: "skipped" }
  | { status: "failed"; error: string }
  | { status: "ready"; plan: FramePlanSliceData; lut: LutSelection };

export function prepareLayerEffect(input: {
  header: FrameHeaderSlice;
  composition: Composition;
  layer: Layer;
  instanceId: string;
  time: number;
  mipLevelCount: number;
  planner: LutSelectionPlanner;
  lut?: LutSelection;
}): PreparedLayerEffect {
  try {
    const { header, composition, layer, instanceId, time } = input;
    const { width, height } = header.render_target;
    const program = compileEffectProgram(
      composition,
      time,
      [layer],
      Math.min(width / composition.width, height / composition.height),
    );
    if (layer.kind === "adjustment" && program.count === 0) return { status: "skipped" };
    const lut = input.lut ?? input.planner.prepare(instanceId, layer);
    const resource = suppliedLutResource(lut);
    const uniforms = buildPostProcessUniforms(
      width,
      height,
      time,
      defaultPostProcessParameters(),
      program.count,
      true,
      Math.max(0, input.mipLevelCount - 1),
      program.usesGlow,
    );
    return {
      status: "ready",
      lut,
      plan: buildLayerEffectSlice(header, {
        instanceId,
        blendMode: layer.blendMode,
        route: layer.kind === "adjustment" ? "adjustment" : "layer",
        lutHash: resource.message.hash,
        program,
        uniforms,
      }),
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function suppliedLayerEffect(
  input: PreparedLayerEffect | undefined,
  width: number,
  height: number,
  route: "layer" | "adjustment",
) {
  requirePlan(input, "missing_resource", "Missing prepared layer effect");
  if (input.status === "failed") throw Error(input.error);
  requirePlan(input.status === "ready", "invalid_layer_effect", "Expected executable effect");
  const plan = readLayerEffectSlice(input.plan);
  requirePlan(
    plan.slice.route === route &&
      plan.metadata.header.render_target.width === width &&
      plan.metadata.header.render_target.height === height,
    "invalid_layer_effect",
    "Effect target or route differs",
  );
  requirePlan(
    suppliedLutResource(input.lut).message.hash === plan.slice.lut_hash,
    "missing_resource",
    "Supplied LUT differs from effect binding",
  );
  return { ...plan, lut: input.lut };
}
