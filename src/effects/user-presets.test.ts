import { describe, expect, it, vi } from "vitest";
import { createEffect } from "./registry";
import {
  addUserEffectPreset,
  createEffectsFromUserPreset,
  createUserEffectPreset,
  readUserEffectPresets,
  removeUserEffectPreset,
  writeUserEffectPresets,
} from "./user-presets";

describe("user effect presets", () => {
  it("round-trips a chain and regenerates effect and keyframe ids", () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn().mockReturnValueOnce("preset-id").mockReturnValue("new-id"),
    });
    const exposure = createEffect("exposure");
    exposure.parameters.exposure = 2.25;
    exposure.mask = {
      shape: "ellipse",
      center: [42, 51],
      size: [35, 60],
      feather: 18,
      opacity: 90,
      invert: false,
    };
    exposure.parameterKeyframes = {
      exposure: [
        { id: "old-key", time: 2, value: 1.5, interpolation: "bezier", easing: [0.2, 0, 0.8, 1] },
      ],
    };
    const preset = createUserEffectPreset("  Hero Glow  ", [exposure], new Date("2026-08-20"));
    const storage = memoryStorage();
    writeUserEffectPresets(storage, [preset]);
    const restored = readUserEffectPresets(storage);
    const effects = createEffectsFromUserPreset(restored[0]);

    expect(restored[0].name).toBe("Hero Glow");
    expect(effects[0]).toMatchObject({ type: "exposure", mask: exposure.mask });
    expect(effects[0].parameters.exposure).toBe(2.25);
    expect(effects[0].id).toBe("new-id");
    expect(effects[0].parameterKeyframes?.exposure[0].id).toBe("new-id");
    vi.unstubAllGlobals();
  });

  it("bounds and validates untrusted persisted data", () => {
    const storage = memoryStorage();
    storage.setItem(
      "aster.user-effect-presets.v1",
      JSON.stringify([
        {
          id: "safe",
          name: "Safe",
          createdAt: "2026-08-20T00:00:00.000Z",
          effects: [{ type: "exposure", enabled: true, parameters: { exposure: 999 } }],
        },
        { id: "bad", name: "Bad", createdAt: "today", effects: [] },
      ]),
    );
    const presets = readUserEffectPresets(storage);
    expect(presets).toHaveLength(1);
    expect(presets[0].effects[0].parameters.exposure).toBe(10);
  });

  it("adds, removes, and rejects resource-backed chains", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "preset" });
    const effect = createEffect("lut");
    effect.resource = {
      kind: "lut3d",
      name: "large.cube",
      size: 2,
      data: Array(24).fill(0),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      checksum: "abc",
    };
    expect(() => createUserEffectPreset("LUT", [effect])).toThrow("project-bound");
    const clean = createUserEffectPreset("Exposure", [createEffect("exposure")]);
    expect(removeUserEffectPreset(addUserEffectPreset([], clean), clean.id)).toEqual([]);
    vi.unstubAllGlobals();
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
