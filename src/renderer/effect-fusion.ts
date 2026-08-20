import type { Effect } from "../core/types";
import { EFFECT_BY_TYPE } from "../effects/registry";
import { MAX_EFFECT_OPERATIONS } from "./effect-program";

export interface EffectFusionGroup {
  kind: "fused" | "barrier" | "unsupported";
  execution: "fused-pixel" | "multi-pass" | "compute" | "temporal" | "missing" | "overflow";
  effectIds: string[];
  operationCount: number;
}

export interface EffectFusionAnalysis {
  groups: EffectFusionGroup[];
  fusedEffectCount: number;
  fusedGroupCount: number;
  barrierCount: number;
  operationCount: number;
}

export function analyzeEffectFusion(effects: Effect[]): EffectFusionAnalysis {
  const groups: EffectFusionGroup[] = [];
  let operationCount = 0;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const definition = EFFECT_BY_TYPE.get(effect.type);
    if (!definition) {
      groups.push(group("unsupported", "missing", effect, 0));
      continue;
    }
    const cost = 1 + (effect.mask ? 2 : 0);
    if (operationCount + cost > MAX_EFFECT_OPERATIONS) {
      groups.push(group("unsupported", "overflow", effect, 0));
      continue;
    }
    operationCount += cost;
    if (definition.execution !== "fused-pixel") {
      groups.push(group("barrier", definition.execution, effect, cost));
      continue;
    }
    const previous = groups[groups.length - 1];
    if (previous?.kind === "fused" && lutCompatible(previous, effect, effects)) {
      previous.effectIds.push(effect.id);
      previous.operationCount += cost;
    } else {
      groups.push(group("fused", "fused-pixel", effect, cost));
    }
  }
  return {
    groups,
    fusedEffectCount: groups
      .filter((candidate) => candidate.kind === "fused")
      .reduce((count, candidate) => count + candidate.effectIds.length, 0),
    fusedGroupCount: groups.filter((candidate) => candidate.kind === "fused").length,
    barrierCount: groups.filter((candidate) => candidate.kind !== "fused").length,
    operationCount,
  };
}

function group(
  kind: EffectFusionGroup["kind"],
  execution: EffectFusionGroup["execution"],
  effect: Effect,
  operationCount: number,
): EffectFusionGroup {
  return { kind, execution, effectIds: [effect.id], operationCount };
}

function lutCompatible(group: EffectFusionGroup, effect: Effect, effects: Effect[]): boolean {
  if (effect.type !== "lut") return true;
  const groupLuts = new Set(
    effects
      .filter((candidate) => group.effectIds.includes(candidate.id) && candidate.type === "lut")
      .map((candidate) => candidate.resource?.checksum ?? "identity"),
  );
  return groupLuts.size === 0 || groupLuts.has(effect.resource?.checksum ?? "identity");
}
