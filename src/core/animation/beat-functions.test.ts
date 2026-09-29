import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./expressions";
import { evaluateTextSelectorExpression } from "./text-selector-expression";

describe("beat expression functions", () => {
  it("counts beats and phases from a bpm and grid offset in layer expressions", () => {
    const at = (expression: string, time: number) =>
      evaluateExpression(expression, { time, value: 5 });
    expect(at("beat(150, 0.4)", 0.4)).toBe(0);
    expect(at("beat(150, 0.4)", 0.4 + 2.5 * 0.4)).toBe(2);
    expect(at("beatphase(150, 0.4)", 0.4 + 0.1)).toBeCloseTo(0.25, 6);
    expect(at("beatphase(150, 0.4, 2)", 0.4 + 0.1)).toBeCloseTo(0.5, 6);
    expect(at("value + 10 * pow(1 - beatphase(120), 3)", 0)).toBe(15);
    expect(at("linear(time, 0, 2, 0, 100)", 3)).toBe(150);
    expect(at("ease(time, 0, 2, 0, 100)", 3)).toBe(100);
  });

  it("is available to text selector expressions", () => {
    expect(
      evaluateTextSelectorExpression("100 * beatphase(120, 0)", {
        textIndex: 1,
        textTotal: 1,
        selectorValue: 100,
        time: 0.25,
      }),
    ).toBeCloseTo(50, 6);
  });
});
