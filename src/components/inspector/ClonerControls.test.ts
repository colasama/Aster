import { describe, expect, it } from "vitest";
import { validateClonerSettings } from "../../core/scene/cloner";
import { createClonerEffector, normalizedDefaultCloner } from "./ClonerControls";

describe("cloner controls", () => {
  it("creates valid defaults for every exposed effector", () => {
    const effectors = (["position", "scale", "rotation", "random", "audio"] as const).map(
      createClonerEffector,
    );
    const settings = { ...normalizedDefaultCloner(), effectors };
    expect(() => validateClonerSettings(settings)).not.toThrow();
    expect(new Set(effectors.map((effector) => effector.id)).size).toBe(effectors.length);
  });

  it("uses a bounded visible three-column grid default", () => {
    const settings = normalizedDefaultCloner();
    expect(settings.distribution).toEqual({
      kind: "grid",
      count: [3, 1, 1],
      spacing: [240, 0, 0],
    });
    expect(settings.effectors).toEqual([]);
  });
});
