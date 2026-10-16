import type { PreparedLayerEffect } from "../effects/layer-effect-plan";
import { suppliedLutResource } from "../media/lut-selection-plan";
import { compositionIdentityFromString as identity } from "./composition-identity";
import { type PrecompositionEffectRecord, utf16Text } from "./precomposition-bundle-layout";
import type { PrecompositionBundleResources } from "./precomposition-bundle-resources";

export function buildBundleEffects(
  effects: ReadonlyMap<string, PreparedLayerEffect>,
  resources: PrecompositionBundleResources,
): PrecompositionEffectRecord[] {
  return [...effects].map(([id, effect]): PrecompositionEffectRecord => {
    const base = {
      instance_id: identity(id),
      execution: resources.addRequiredPlan(effect.execution, "effect_execution_slice_v1"),
    };
    if (effect.status === "ready") {
      const lut = suppliedLutResource(effect.lut);
      const lutHash = resources.add(lut);
      resources.resolve(lutHash);
      return {
        ...base,
        status: "ready",
        plan: resources.addRequiredPlan(effect.plan, "layer_effects_slice_v1"),
        lut: lutHash,
        label_utf16: utf16Text(lut.label),
      };
    }
    if (effect.status === "failed")
      return { ...base, status: "failed", error_utf16: utf16Text(effect.error) };
    return { ...base, status: effect.status };
  });
}

/** Capture all effect fields before waiting for independently owned plan digests. */
export async function buildBundleEffectsAsync(
  effects: ReadonlyMap<string, PreparedLayerEffect>,
  resources: PrecompositionBundleResources,
): Promise<PrecompositionEffectRecord[]> {
  const results = await Promise.allSettled(
    [...effects].map(async ([id, effect]): Promise<PrecompositionEffectRecord> => {
      const instanceId = identity(id);
      const execution = resources.addRequiredPlanAsync(
        effect.execution,
        "effect_execution_slice_v1",
      );
      if (effect.status === "ready") {
        const lut = suppliedLutResource(effect.lut),
          label = utf16Text(lut.label);
        const lutHash = resources.add(lut);
        resources.resolve(lutHash);
        const plan = resources.addRequiredPlanAsync(effect.plan, "layer_effects_slice_v1");
        return {
          instance_id: instanceId,
          status: "ready",
          execution: await execution,
          plan: await plan,
          lut: lutHash,
          label_utf16: label,
        };
      }
      if (effect.status === "failed") {
        const error = utf16Text(effect.error);
        return {
          instance_id: instanceId,
          execution: await execution,
          status: "failed",
          error_utf16: error,
        };
      }
      const status = effect.status;
      return { instance_id: instanceId, execution: await execution, status };
    }),
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
