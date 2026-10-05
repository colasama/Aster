import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import { suppliedLutResource } from "../media/lut-selection-plan";
import type { GeneratorShaderResource } from "../scene/scene-generator-program";
import { requirePlan } from "./canonical";
import { compositionIdentityToString as text } from "./composition-identity";
import { readEffectExecutionSlice } from "./effect-execution-plan";
import { readGeneratorSlice, validateGeneratorResources } from "./generator-plan";
import { readLayerEffectSlice } from "./layer-effect-plan";
import {
  type PrecompositionEffectRecord,
  type PrecompositionSceneRecord,
  readUtf16Text,
} from "./precomposition-bundle-layout";
import type { PrecompositionBundleResources } from "./precomposition-bundle-resources";
import type { FramePlanSliceData } from "./types";
export function readBundlePrograms(
  effectRecords: PrecompositionEffectRecord[],
  generatorRecords: PrecompositionSceneRecord["generators"],
  resources: PrecompositionBundleResources,
  matchingFrame: (plan: FramePlanSliceData) => void,
) {
  const effects = new Map<string, PreparedLayerEffect>();
  for (const effectRecord of effectRecords) {
    const id = text(effectRecord.instance_id),
      execution = resources.plan(effectRecord.execution, "effect_execution_slice_v1");
    matchingFrame(execution);
    requirePlan(
      readEffectExecutionSlice(execution).instanceId === id,
      "invalid_precomposition",
      "Bundled effect identity differs",
    );
    if (effectRecord.status === "ready") {
      const plan = resources.plan(effectRecord.plan, "layer_effects_slice_v1"),
        effect = readLayerEffectSlice(plan),
        lut = resources.resolve(effectRecord.lut);
      matchingFrame(plan);
      requirePlan(
        effect.instanceId === id && effect.slice.lut_hash === effectRecord.lut,
        "invalid_precomposition",
        "Bundled effect LUT/identity differs",
      );
      requirePlan(
        lut.message.kind === "texture_pixels",
        "invalid_resource",
        "Bundled LUT has wrong kind",
      );
      const selection = {
        status: "ready" as const,
        resource: {
          message: lut.message,
          bytes: new Uint8Array(lut.bytes),
          label: readUtf16Text(effectRecord.label_utf16),
        },
      };
      suppliedLutResource(selection);
      effects.set(id, { status: "ready", plan, execution, lut: selection });
    } else if (effectRecord.status === "failed")
      effects.set(id, {
        status: "failed",
        execution,
        error: readUtf16Text(effectRecord.error_utf16),
      });
    else effects.set(id, { status: effectRecord.status, execution });
  }
  const generators = generatorRecords.map((record) => {
    const plan = resources.plan(record.plan, "scene_generator_slice_v1");
    matchingFrame(plan);
    const shaders = plan.metadata.resources.map((hash): GeneratorShaderResource => {
      const shader = resources.resolve(hash);
      requirePlan(
        shader.message.kind === "buffer",
        "invalid_resource",
        "Bundled shader has wrong kind",
      );
      return { message: shader.message, bytes: shader.bytes };
    });
    const decoded = readGeneratorSlice(plan, new Map(shaders.map((s) => [s.message.hash, s])));
    validateGeneratorResources(decoded);
    if (record.execution.status === "ready")
      requirePlan(
        record.execution.effective_count ===
          Math.min(decoded.effectiveCount, record.execution.capacity),
        "invalid_precomposition",
        "Captured generator count differs from invocation",
      );
    requirePlan(
      decoded.instanceId === text(record.instance_id),
      "invalid_precomposition",
      "Bundled generator identity differs",
    );
    return {
      instanceId: decoded.instanceId,
      ...(record.execution.status === "planned"
        ? {}
        : { execution: structuredClone(record.execution) }),
      plan,
      shaders,
      origin: {
        layerName: readUtf16Text(record.layer_name_utf16),
        pluginId: readUtf16Text(record.plugin_id_utf16),
      },
    };
  });
  return { effects, generators };
}
