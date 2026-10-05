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
    const base = { instance_id: identity(id), execution: resources.addPlan(effect.execution) };
    if (effect.status === "ready") {
      const lut = suppliedLutResource(effect.lut);
      return {
        ...base,
        status: "ready",
        plan: resources.addPlan(effect.plan),
        lut: resources.add(lut),
        label_utf16: utf16Text(lut.label),
      };
    }
    if (effect.status === "failed")
      return { ...base, status: "failed", error_utf16: utf16Text(effect.error) };
    return { ...base, status: effect.status };
  });
}
