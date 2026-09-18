import { describe, expect, it } from "vitest";
import { createBlankProject } from "../project/project";
import { evaluateExpression, evaluateLayerTransform } from "./expressions";

describe("safe expressions", () => {
  it("evaluates arithmetic, variables, and functions", () => {
    expect(evaluateExpression("value + sin(time * pi) * 20", { time: 0.5, value: 10 })).toBeCloseTo(
      30,
    );
    expect(evaluateExpression("clamp(pow(3, 2), 0, 5)", { time: 0, value: 0 })).toBe(5);
  });

  it("applies expressions during arbitrary-time transform evaluation", () => {
    const layer = createBlankProject(true).compositions[0].layers[0];
    layer.expressions = { "position.0": "value + time * 100" };
    expect(evaluateLayerTransform(layer, 2).position[0]).toBe(1160);
  });

  it("rejects access outside the expression language", () => {
    expect(() => evaluateExpression("globalThis.alert(1)", { time: 0, value: 0 })).toThrow();
  });

  it("bounds expression work before evaluation", () => {
    expect(() => evaluateExpression(`${"1+".repeat(300)}1`, { time: 0, value: 0 })).toThrow(
      /tokens/,
    );
    expect(() =>
      evaluateExpression(`${"(".repeat(33)}1${")".repeat(33)}`, { time: 0, value: 0 }),
    ).toThrow(/levels/);
    expect(() => evaluateExpression("1".repeat(2_049), { time: 0, value: 0 })).toThrow(
      /characters/,
    );
  });
});
