import { describe, expect, it } from "vitest";
import { createEffectsFromPreset, LOOK_PRESETS } from "./presets";
import { EFFECT_BY_TYPE } from "./registry";

describe("Looks presets", () => {
  it("uses stable unique identifiers and valid effect parameters", () => {
    expect(new Set(LOOK_PRESETS.map((preset) => preset.id)).size).toBe(LOOK_PRESETS.length);
    for (const preset of LOOK_PRESETS) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(preset.palette).toHaveLength(3);
      expect(preset.palette.every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
      expect(preset.effects.length).toBeGreaterThan(0);
      const effects = createEffectsFromPreset(preset);
      for (const effect of effects) {
        const definition = EFFECT_BY_TYPE.get(effect.type);
        expect(definition).toBeDefined();
        for (const parameter of definition?.parameters ?? []) {
          const value = effect.parameters[parameter.key];
          expect(Number.isFinite(value)).toBe(true);
          if (parameter.min !== undefined) expect(value).toBeGreaterThanOrEqual(parameter.min);
          if (parameter.max !== undefined) expect(value).toBeLessThanOrEqual(parameter.max);
        }
      }
    }
  });

  it("creates fresh effect instances for every application", () => {
    const first = createEffectsFromPreset(LOOK_PRESETS[0]);
    const second = createEffectsFromPreset(LOOK_PRESETS[0]);
    expect(first.map((effect) => effect.id)).not.toEqual(second.map((effect) => effect.id));
  });
});
