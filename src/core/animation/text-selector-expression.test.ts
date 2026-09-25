import { describe, expect, it } from "vitest";
import {
  evaluateTextSelectorExpression,
  safeEvaluateTextSelectorExpression,
  textSelectorExpressionError,
} from "./text-selector-expression";

const context = { textIndex: 2, textTotal: 4, selectorValue: 80, time: 1.5 };

describe("text selector expression host", () => {
  it("evaluates selector variables and bounded numeric helpers", () => {
    expect(evaluateTextSelectorExpression("selectorValue * textIndex / textTotal", context)).toBe(
      40,
    );
    expect(evaluateTextSelectorExpression("sin(time * pi) * 50", context)).toBeCloseTo(-50);
    expect(
      evaluateTextSelectorExpression("clamp(linear(textIndex, 1, 4, 0, 100), 0, 100)", context),
    ).toBeCloseTo(100 / 3);
  });

  it("supports the legacy cascade expression used by schema migration", () => {
    expect(
      evaluateTextSelectorExpression(
        "100 * pow(1 - clamp((time - 1 - (textIndex - 1) * 0.1) / 2, 0, 1), 3)",
        context,
      ),
    ).toBeCloseTo(51.2);
  });

  it("rejects executable or unbounded syntax and safely falls back", () => {
    expect(() => evaluateTextSelectorExpression("globalThis.process.exit()", context)).toThrow();
    expect(() => evaluateTextSelectorExpression("1 / 0", context)).toThrow("not finite");
    expect(safeEvaluateTextSelectorExpression("alert(1)", context)).toBe(80);
    expect(textSelectorExpressionError("globalThis.alert(1)")).toMatch(/invalid|Unsupported/u);
    expect(textSelectorExpressionError("selectorValue * 2")).toBeUndefined();
    expect(textSelectorExpressionError("1 / 0")).toBe("Text selector expression is not finite");
    expect(safeEvaluateTextSelectorExpression("1 / 0", context)).toBe(80);
  });

  it("recovers from runtime failures that only apply to some contexts", () => {
    const bad = { textIndex: 1, textTotal: 4, selectorValue: 80, time: 1 };
    const good = { textIndex: 1, textTotal: 4, selectorValue: 80, time: 3 };
    expect(safeEvaluateTextSelectorExpression("100 / (time - 1)", bad)).toBe(80);
    expect(safeEvaluateTextSelectorExpression("100 / (time - 1)", good)).toBe(50);
    expect(safeEvaluateTextSelectorExpression("100 / (time - 1)", bad)).toBe(80);
  });
});
