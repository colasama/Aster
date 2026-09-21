import type { Effect, Layer } from "../../core/types";

export interface EffectTarget {
  layer: Layer;
  effect: Effect;
}

/** Match repeated effects by type and occurrence, independently of each layer's stack order. */
export function commonEffectTargets(layers: readonly Layer[]): EffectTarget[][] {
  const first = layers[0];
  if (!first) return [];
  return first.effects.flatMap((effect, index) => {
    const occurrence = first.effects
      .slice(0, index)
      .filter((entry) => entry.type === effect.type).length;
    const targets = layers.flatMap((layer) => {
      const match = layer.effects.filter((entry) => entry.type === effect.type)[occurrence];
      return match ? [{ layer, effect: match }] : [];
    });
    return targets.length === layers.length ? [targets] : [];
  });
}
