import { describe, expect, it } from "vitest";
import {
  combineSelectorValue,
  evaluateTextSelector,
  evaluateTextSelectors,
  type TextRangeSelector,
  type TextUnitContext,
  type TextWigglySelector,
} from "./text-selectors";

const unit = (characterIndex: number): TextUnitContext => ({
  characterIndex,
  characterCount: 10,
  characterExcludingSpacesIndex: characterIndex,
  characterExcludingSpacesCount: 10,
  wordIndex: characterIndex < 5 ? 0 : 1,
  wordCount: 2,
  lineIndex: 0,
  lineCount: 1,
  isWhitespace: false,
});

const range = (overrides: Partial<TextRangeSelector> = {}): TextRangeSelector => ({
  id: "range",
  enabled: true,
  kind: "range",
  mode: "add",
  amount: 100,
  basedOn: "characters",
  units: "percentage",
  start: 0,
  end: 50,
  offset: 0,
  shape: "square",
  smoothness: 100,
  easeHigh: 0,
  easeLow: 0,
  randomizeOrder: false,
  randomSeed: 0,
  ...overrides,
});

describe("text selectors", () => {
  it("evaluates percentage/index ranges and AE range shapes", () => {
    expect(evaluateTextSelector(range(), unit(0), { time: 0 })).toBe(1);
    expect(evaluateTextSelector(range(), unit(7), { time: 0 })).toBe(0);
    expect(
      evaluateTextSelector(range({ units: "index", start: 2, end: 4 }), unit(2), { time: 0 }),
    ).toBe(1);
    const ramp = range({ shape: "rampUp", end: 100 });
    expect(evaluateTextSelector(ramp, unit(1), { time: 0 })).toBeLessThan(
      evaluateTextSelector(ramp, unit(8), { time: 0 }),
    );
    const triangle = range({ shape: "triangle", end: 100 });
    expect(evaluateTextSelector(triangle, unit(4), { time: 0 })).toBeGreaterThan(
      evaluateTextSelector(triangle, unit(0), { time: 0 }),
    );
  });

  it("supports characters excluding spaces, words, and lines", () => {
    expect(
      evaluateTextSelector(
        range({ basedOn: "charactersExcludingSpaces" }),
        {
          ...unit(2),
          isWhitespace: true,
          characterExcludingSpacesIndex: undefined,
        },
        { time: 0 },
      ),
    ).toBe(0);
    expect(
      evaluateTextSelector(range({ basedOn: "words", units: "index", start: 1, end: 2 }), unit(8), {
        time: 0,
      }),
    ).toBe(1);
  });

  it("randomizes range order deterministically without changing membership count", () => {
    const selector = range({ randomizeOrder: true, randomSeed: 42, end: 30 });
    const first = Array.from({ length: 10 }, (_, index) =>
      evaluateTextSelector(selector, unit(index), { time: 0 }),
    );
    const second = Array.from({ length: 10 }, (_, index) =>
      evaluateTextSelector(selector, unit(index), { time: 100 }),
    );
    expect(second).toEqual(first);
    expect(first.filter((value) => value === 1)).toHaveLength(3);
  });

  it("evaluates seeded, temporally continuous wiggly selectors", () => {
    const selector: TextWigglySelector = {
      id: "wiggle",
      enabled: true,
      kind: "wiggly",
      mode: "add",
      amount: 100,
      basedOn: "characters",
      minimumAmount: -100,
      maximumAmount: 100,
      wigglesPerSecond: 2,
      correlation: 0,
      temporalPhase: 0,
      spatialPhase: 1,
      randomSeed: 99,
    };
    const atOne = evaluateTextSelector(selector, unit(3), { time: 1 });
    expect(evaluateTextSelector(selector, unit(3), { time: 1 })).toBe(atOne);
    expect(evaluateTextSelector(selector, unit(3), { time: 1.001 })).toBeCloseTo(atOne, 2);
    expect(evaluateTextSelector(selector, unit(4), { time: 1 })).not.toBe(atOne);
  });

  it("combines stacked selectors and provides one-based expression variables", () => {
    expect(combineSelectorValue(0.8, 0.25, "subtract")).toBeCloseTo(0.55);
    expect(combineSelectorValue(0.8, 0.25, "intersect")).toBeCloseTo(0.2);
    const expression = {
      id: "expression",
      enabled: true,
      kind: "expression" as const,
      mode: "intersect" as const,
      amount: 100,
      basedOn: "characters" as const,
      expression: "textIndex / textTotal",
    };
    expect(
      evaluateTextSelectors([range({ end: 100 }), expression], unit(4), {
        time: 2,
        evaluateExpression: (_source, context) =>
          (context.textIndex / context.textTotal) * context.selectorValue,
      }),
    ).toBeCloseTo(0.5);
  });
});
