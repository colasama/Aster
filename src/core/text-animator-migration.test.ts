import { describe, expect, it } from "vitest";
import { evaluateMigratedTextAnimator, migrateLegacyTextAnimator } from "./text-animator-migration";
import { segmentTextLayoutUnits } from "./text-animator-stack";

describe("legacy text animator migration", () => {
  it("preserves the legacy staggered reveal at arbitrary times", () => {
    const legacy = {
      enabled: true,
      delay: 0.2,
      stagger: 0.12,
      duration: 0.75,
      position: [24, -80] as [number, number],
      scale: 65,
      opacity: 15,
    };
    const migrated = migrateLegacyTextAnimator(legacy, "text-layer");
    const units = segmentTextLayoutUnits("ABCD");
    for (const time of [-0.25, 0.2, 0.43, 0.95, 2]) {
      for (const [index, unit] of units.entries()) {
        const before = evaluateLegacy(legacy, time, index);
        const after = evaluateMigratedTextAnimator(migrated, unit, time);
        expect(after.position[0]).toBeCloseTo(before.position[0], 8);
        expect(after.position[1]).toBeCloseTo(before.position[1], 8);
        expect(after.scale[0]).toBeCloseTo(before.scale, 8);
        expect(after.scale[1]).toBeCloseTo(before.scale, 8);
        expect(after.opacity).toBeCloseTo(before.opacity, 8);
      }
    }
  });

  it("uses deterministic ids and safe bounded legacy values", () => {
    const migrated = migrateLegacyTextAnimator(
      {
        enabled: 1,
        delay: Number.NaN,
        duration: 0,
        position: [Number.POSITIVE_INFINITY, -20_000],
        scale: 20_000,
        opacity: -10,
      },
      "layer-7",
    );
    expect(migrated).toMatchObject({
      enabled: true,
      groups: [
        {
          id: "layer-7:animator:1",
          selectors: [{ id: "layer-7:selector:1" }],
          properties: {
            position: [
              { mode: "static", value: 0 },
              { mode: "static", value: -8192 },
              { mode: "static", value: 0 },
            ],
            scale: [
              { mode: "static", value: 1000 },
              { mode: "static", value: 1000 },
              { mode: "static", value: 100 },
            ],
            opacity: { mode: "static", value: 0 },
          },
        },
      ],
    });
  });
});

function evaluateLegacy(
  settings: {
    delay: number;
    stagger: number;
    duration: number;
    position: [number, number];
    scale: number;
    opacity: number;
  },
  time: number,
  index: number,
) {
  const progress = Math.max(
    0,
    Math.min(1, (time - settings.delay - index * settings.stagger) / settings.duration),
  );
  const remaining = (1 - progress) ** 3;
  return {
    position: settings.position.map((value) => value * remaining),
    scale: (100 + (settings.scale - 100) * remaining) / 100,
    opacity: (100 + (settings.opacity - 100) * remaining) / 100,
  };
}
