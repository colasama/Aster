import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition, Layer } from "../../core/types";
import { needsBackdropBlend, needsLayerIsolation } from "../compositing/layer-composite";
import { canonicalJson, requirePlan } from "../frame-plan/canonical";
import {
  buildEffectExecutionSlice,
  readEffectExecutionSlice,
} from "../frame-plan/effect-execution-plan";
import { buildLayerEffectSlice, readLayerEffectSlice } from "../frame-plan/layer-effect-plan";
import type { FrameHeaderSlice, FramePlanSliceData } from "../frame-plan/types";
import {
  type LutSelection,
  type LutSelectionPlanner,
  suppliedLutResource,
} from "../media/lut-selection-plan";
import { analyzeEffectFusion } from "./effect-fusion";
import { defaultPostProcessParameters } from "./effect-parameters";
import { compileEffectProgram } from "./effect-program";
import { buildPostProcessUniforms } from "./post-process";

export type PreparedLayerEffect =
  | { status: "skipped" | "direct"; execution: FramePlanSliceData }
  | { status: "failed"; error: string; execution: FramePlanSliceData }
  | { status: "ready"; plan: FramePlanSliceData; lut: LutSelection; execution: FramePlanSliceData };

export function prepareLayerEffect(input: {
  header: FrameHeaderSlice;
  composition: Composition;
  layer: Layer;
  instanceId: string;
  time: number;
  mipLevelCount: number;
  planner: LutSelectionPlanner;
  lut?: LutSelection;
  context?: "root" | "precomposition" | "isolated";
}): PreparedLayerEffect {
  const { header, composition, layer, instanceId, time } = input;
  const adjustment = layer.kind === "adjustment";
  const isolate = needsLayerIsolation(layer);
  const enabled = layer.effects.some((effect) => effect.enabled);
  const route = adjustment
    ? (input.context === "precomposition" ? isolate : enabled)
      ? "adjustment"
      : "skip"
    : input.context === "isolated" || isolate
      ? "layer"
      : "direct";
  const analysis = analyzeEffectFusion(layer.effects);
  const execution = buildEffectExecutionSlice(header, {
    instanceId,
    layerId: layer.id,
    route,
    blendMode: layer.blendMode,
    composite:
      route === "layer"
        ? needsBackdropBlend(layer.blendMode)
          ? "backdrop"
          : "fixed"
        : route === "adjustment"
          ? "replace"
          : "none",
    fusion: analysis,
  });
  if (route === "skip") return { status: "skipped", execution };
  if (route === "direct") return { status: "direct", execution };
  try {
    const { width, height } = header.render_target;
    const program = compileEffectProgram(
      composition,
      time,
      [layer],
      Math.min(width / composition.width, height / composition.height),
    );
    if (layer.kind === "adjustment" && program.count === 0) return { status: "skipped", execution };
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
      execution,
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
    return {
      status: "failed",
      execution,
      error: error instanceof Error ? error.message : String(error),
    };
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
  const execution = readEffectExecutionSlice(input.execution);
  requirePlan(
    execution.route === route &&
      execution.blendMode === plan.slice.blend_mode &&
      execution.instanceId === plan.instanceId &&
      canonicalJson(input.execution.metadata.header) === canonicalJson(plan.metadata.header),
    "invalid_effect_execution",
    "Execution and program bindings differ",
  );
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
  return { ...plan, execution, lut: input.lut };
}

export function effectExecution(input: PreparedLayerEffect | undefined) {
  requirePlan(input, "missing_resource", "Missing prepared effect execution");
  return readEffectExecutionSlice(input.execution);
}

export function prepareLayerEffects(input: {
  scene: readonly FlattenedSceneLayer[];
  composition: Composition;
  header: FrameHeaderSlice;
  mipLevelCount: number;
  planner: LutSelectionPlanner;
  context: "root" | "precomposition";
}): ReadonlyMap<string, PreparedLayerEffect> {
  return new Map(
    input.scene.map((item) => [
      item.instanceId,
      prepareLayerEffect({
        ...input,
        layer: item.layer,
        instanceId: item.instanceId,
        time: item.localTime,
      }),
    ]),
  );
}
