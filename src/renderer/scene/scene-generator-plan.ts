import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import { AUDIO_ANALYSIS_BYTES } from "../../core/audio/audio-analysis-frame";
import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { SceneGeneratorDefinition } from "../../core/scene/scene-generator-registry";
import { BLEND_MODES, type BlendMode, type Composition } from "../../core/types";
import type { SceneCamera } from "../geometry/geometry";
import {
  buildSceneGeneratorContext,
  buildSceneGeneratorParameters,
  SCENE_GENERATOR_CONTEXT_BYTES,
  SCENE_GENERATOR_PARAMETER_BYTES,
} from "./scene-generator-abi";
import { planGeneratorCapacity } from "./scene-generator-capacity";
import {
  buildGeneratorProgram,
  type GeneratorProgramPlan,
  generatorProgramKey,
} from "./scene-generator-program";

export type SceneGeneratorAudioSource = () => Float32Array;
export interface SceneGeneratorPlan {
  instanceId: string;
  selectionId: string;
  blendMode: BlendMode;
  program: GeneratorProgramPlan;
  variantIndex: number;
  requestedCount: number;
  effectiveCount: number;
  capacity: number;
  context: Uint8Array;
  parameters: Uint8Array;
  indirect: Uint8Array;
  dispatches: [number, number, number][];
  audio?: Uint8Array;
}
/** Owns root-time audio once; nested generators reuse that frame's evaluated bytes. */
export class SceneGeneratorPlanner {
  readonly #programs = new WeakMap<SceneGeneratorDefinition, GeneratorProgramPlan>();
  #audioSource?: SceneGeneratorAudioSource;
  #audio?: Uint8Array;
  beginFrame(source?: SceneGeneratorAudioSource): void {
    this.#audioSource = source;
    this.#audio = undefined;
  }
  prepare(input: {
    scene: FlattenedSceneLayer;
    composition: Composition;
    definition: SceneGeneratorDefinition;
    width: number;
    height: number;
    memoryBudgetMb?: number;
    camera?: SceneCamera;
    storageByteLimit: number;
    dispatchWorkgroupLimit: number;
  }): SceneGeneratorPlan {
    const { scene, composition, definition } = input;
    const instance = scene.layer.generator;
    if (!instance || instance.apiVersion !== definition.apiVersion)
      throw Error("Generator instance API differs from definition");
    let program = this.#programs.get(definition);
    if (!program) {
      program = buildGeneratorProgram(definition);
      this.#programs.set(definition, program);
    }
    const selector = definition.graph.render_parameter
      ? String(instance.parameters[definition.graph.render_parameter] ?? "")
      : undefined;
    const selected = definition.graph.render_variants.findIndex(
      (v) => v.selector_value === selector,
    );
    const variantIndex = Math.max(0, selected);
    const variant = program.graph.render_variants[variantIndex];
    const capacityParameter = definition.parameters.find(
      (p) => p.name === definition.graph.capacity_parameter,
    );
    const fallback = capacityParameter?.type === "number" ? capacityParameter.default : 1;
    const value = instance.parameters[definition.graph.capacity_parameter];
    const requestedCount = Math.max(
      1,
      Math.min(
        definition.graph.max_instances,
        Math.round(typeof value === "number" && Number.isFinite(value) ? value : fallback),
      ),
    );
    const capacity = planGeneratorCapacity(
      requestedCount,
      definition.graph.max_instances,
      definition.graph.instance_stride,
      variant.vertex_count,
      input.memoryBudgetMb,
      input.storageByteLimit,
      input.dispatchWorkgroupLimit *
        Math.min(...program.graph.compute_passes.map((p) => p.workgroup_size[0])),
    );
    const localTime = evaluateLayerSourceTime(scene.layer, scene.localTime);
    const context = buildSceneGeneratorContext(
      localTime === scene.localTime ? scene : { ...scene, localTime },
      composition,
      input.camera,
      input.width,
      input.height,
      scene.localTime,
      composition.frameRate.denominator / Math.max(composition.frameRate.numerator, 1),
      capacity.effectiveCount,
    );
    const parameters = buildSceneGeneratorParameters(definition, instance);
    if (program.audioAnalysis && !this.#audio && this.#audioSource) {
      const audio = this.#audioSource();
      if (audio.byteLength !== AUDIO_ANALYSIS_BYTES)
        throw Error("Invalid generator audio payload length");
      this.#audio = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength).slice();
    }
    return {
      instanceId: scene.instanceId,
      selectionId: scene.selectionId,
      blendMode: scene.layer.blendMode,
      program,
      variantIndex,
      requestedCount,
      ...capacity,
      context: new Uint8Array(context),
      parameters: new Uint8Array(
        parameters.buffer,
        parameters.byteOffset,
        parameters.byteLength,
      ).slice(),
      indirect: new Uint8Array(new Uint32Array([variant.vertex_count, 0, 0, 0]).buffer),
      dispatches: program.graph.compute_passes.map((p) => [
        Math.ceil(capacity.effectiveCount / p.workgroup_size[0]),
        1,
        1,
      ]),
      ...(program.audioAnalysis && this.#audio ? { audio: this.#audio } : {}),
    };
  }
}
/** Allocation fallback may reduce a supplied workload, without re-evaluating authoring data. */
export function constrainGeneratorPlan(
  plan: SceneGeneratorPlan,
  capacity: number,
): SceneGeneratorPlan {
  const effectiveCount = Math.min(plan.effectiveCount, capacity);
  if (effectiveCount === plan.effectiveCount) return plan;
  const context = plan.context.slice();
  new DataView(context.buffer).setUint32(24, effectiveCount, true);
  return {
    ...plan,
    effectiveCount,
    context,
    dispatches: plan.program.graph.compute_passes.map((p) => [
      Math.ceil(effectiveCount / p.workgroup_size[0]),
      1,
      1,
    ]),
  };
}
export function validateGeneratorInvocation(plan: SceneGeneratorPlan): void {
  const variant = plan.program.graph.render_variants[plan.variantIndex];
  if (
    plan.program.key !== generatorProgramKey(plan.program) ||
    !variant ||
    !Number.isInteger(plan.variantIndex) ||
    typeof plan.instanceId !== "string" ||
    typeof plan.selectionId !== "string" ||
    !BLEND_MODES.includes(plan.blendMode) ||
    !Number.isInteger(plan.requestedCount) ||
    plan.requestedCount < 1 ||
    plan.requestedCount > plan.program.graph.max_instances ||
    !Number.isInteger(plan.effectiveCount) ||
    plan.effectiveCount < 1 ||
    plan.effectiveCount > plan.requestedCount ||
    !Number.isInteger(plan.capacity) ||
    plan.capacity < plan.effectiveCount ||
    plan.capacity > plan.program.graph.max_instances ||
    plan.context.byteLength !== SCENE_GENERATOR_CONTEXT_BYTES ||
    plan.parameters.byteLength !== SCENE_GENERATOR_PARAMETER_BYTES ||
    plan.indirect.byteLength !== 16 ||
    (plan.audio !== undefined &&
      (!plan.program.audioAnalysis || plan.audio.byteLength !== AUDIO_ANALYSIS_BYTES)) ||
    plan.dispatches.length !== plan.program.graph.compute_passes.length
  )
    throw Error("Invalid generator invocation");
  const context = new DataView(
    plan.context.buffer,
    plan.context.byteOffset,
    plan.context.byteLength,
  );
  const indirect = new DataView(plan.indirect.buffer, plan.indirect.byteOffset, 16);
  if (
    context.getUint32(24, true) !== plan.effectiveCount ||
    indirect.getUint32(0, true) !== variant.vertex_count ||
    [4, 8, 12].some((offset) => indirect.getUint32(offset, true) !== 0)
  )
    throw Error("Generator count payload mismatch");
  plan.dispatches.forEach((d, i) => {
    if (
      d.length !== 3 ||
      d[0] !==
        Math.ceil(plan.effectiveCount / plan.program.graph.compute_passes[i].workgroup_size[0]) ||
      d[1] !== 1 ||
      d[2] !== 1
    )
      throw Error("Generator dispatch mismatch");
  });
}
