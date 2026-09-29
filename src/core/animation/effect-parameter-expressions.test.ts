import { describe, expect, it } from "vitest";
import { validateEffect } from "../project/validation/effects";
import type { Effect } from "../types";
import { evaluateEffectParameter } from "./timeline";

function blur(overrides: Partial<Effect> = {}): Effect {
  return {
    id: "blur",
    type: "gaussian-blur",
    name: "Blur",
    enabled: true,
    parameters: { radius: 10 },
    ...overrides,
  };
}

describe("effect parameter expressions", () => {
  it("evaluates over time and the keyframed value, falling back on errors", () => {
    const pulsing = blur({ parameterExpressions: { radius: "value * 2 + time" } });
    expect(evaluateEffectParameter(pulsing, "radius", 3)).toBe(23);
    const keyed = blur({
      parameterKeyframes: {
        radius: [
          { id: "a", time: 0, value: 0, interpolation: "linear" },
          { id: "b", time: 2, value: 20, interpolation: "linear" },
        ],
      },
      parameterExpressions: { radius: "value + 1" },
    });
    expect(evaluateEffectParameter(keyed, "radius", 1)).toBe(11);
    expect(
      evaluateEffectParameter(blur({ parameterExpressions: { radius: "nope(" } }), "radius", 0),
    ).toBe(10);
  });

  it("validates expression targets and bounds", () => {
    expect(() =>
      validateEffect(blur({ parameterExpressions: { radius: "time" } }), "e"),
    ).not.toThrow();
    expect(() => validateEffect(blur({ parameterExpressions: { amount: "time" } }), "e")).toThrow(
      "unknown parameter",
    );
    expect(() =>
      validateEffect(blur({ parameterExpressions: { radius: "x".repeat(3000) } }), "e"),
    ).toThrow("bounded");
  });
});
