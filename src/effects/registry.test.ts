import { describe, expect, it } from "vitest";
import { createEffect, EFFECT_REGISTRY } from "./registry";

describe("effect registry", () => {
  it("uses unique stable effect and parameter keys", () => {
    expect(new Set(EFFECT_REGISTRY.map((effect) => effect.type)).size).toBe(EFFECT_REGISTRY.length);
    for (const definition of EFFECT_REGISTRY) {
      expect(definition.type).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(new Set(definition.parameters.map((parameter) => parameter.key)).size).toBe(
        definition.parameters.length,
      );
    }
  });

  it("keeps every generated default finite and inside its declared range", () => {
    for (const definition of EFFECT_REGISTRY) {
      const effect = createEffect(definition.type);
      for (const parameter of definition.parameters) {
        const value = effect.parameters[parameter.key];
        expect(Number.isFinite(value), `${definition.type}.${parameter.key}`).toBe(true);
        if (parameter.min !== undefined) expect(value).toBeGreaterThanOrEqual(parameter.min);
        if (parameter.max !== undefined) expect(value).toBeLessThanOrEqual(parameter.max);
      }
    }
  });
});
