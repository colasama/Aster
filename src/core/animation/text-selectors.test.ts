import { describe, expect, it } from "vitest";
import type { Animatable } from "../types";
import { staticValue } from "../types";
import {
  combineSelectorValue,
  evaluateTextSelector,
  evaluateTextSelectors,
  type TextRangeSelector,
  type TextUnitContext,
  type TextWigglySelector,
} from "./text-selectors";

const v = staticValue;
const animated = (start: number, end: number): Animatable => ({
  mode: "animated",
  keyframes: [
    { id: "start", time: 0, value: start, interpolation: "linear" },
    { id: "end", time: 1, value: end, interpolation: "linear" },
  ],
});

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
  name: "Range Selector 1",
  enabled: true,
  kind: "range",
  mode: "add",
  amount: v(100),
  basedOn: "characters",
  units: "percentage",
  start: v(0),
  end: v(50),
  offset: v(0),
  shape: "square",
  smoothness: v(0),
  easeHigh: v(0),
  easeLow: v(0),
  randomizeOrder: false,
  randomSeed: 0,
  ...overrides,
});

describe("text selectors", () => {
  it("evaluates percentage/index ranges and range shapes", () => {
    expect(evaluateTextSelector(range(), unit(0), { time: 0 })).toBe(1);
    expect(evaluateTextSelector(range(), unit(7), { time: 0 })).toBe(0);
    expect(
      evaluateTextSelector(range({ units: "index", start: v(2), end: v(4) }), unit(2), {
        time: 0,
      }),
    ).toBe(1);
    const ramp = range({ shape: "rampUp", end: v(100) });
    expect(evaluateTextSelector(ramp, unit(1), { time: 0 })).toBeLessThan(
      evaluateTextSelector(ramp, unit(8), { time: 0 }),
    );
    const triangle = range({ shape: "triangle", end: v(100) });
    expect(evaluateTextSelector(triangle, unit(4), { time: 0 })).toBeGreaterThan(
      evaluateTextSelector(triangle, unit(0), { time: 0 }),
    );
  });

  it("widens square edges as Smoothness rises and keeps the selection peak", () => {
    // unit(9) sits at 95% position, inside a full-width range.
    const hard = range({ end: v(100), smoothness: v(0) });
    const soft = range({ end: v(100), smoothness: v(100) });
    expect(evaluateTextSelector(hard, unit(9), { time: 0 })).toBe(1);
    const edge = evaluateTextSelector(soft, unit(9), { time: 0 });
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(0.5);
    // The middle of the selection still reaches essentially full weight.
    expect(evaluateTextSelector(soft, unit(4), { time: 0 })).toBeGreaterThan(0.95);
    // A square selector at full smoothness approaches the Smooth shape.
    const bell = range({ shape: "smooth", end: v(100) });
    expect(evaluateTextSelector(soft, unit(4), { time: 0 })).toBeCloseTo(
      evaluateTextSelector(bell, unit(4), { time: 0 }),
      1,
    );
  });

  it("eases gently at each end for positive values and snaps for negative", () => {
    const midUnit = { ...unit(4), characterCount: 10 };
    const ramp = (overrides: Partial<TextRangeSelector>) =>
      evaluateTextSelector(range({ shape: "rampUp", end: v(100), ...overrides }), midUnit, {
        time: 0,
      });
    const linear = ramp({});
    // Positive Ease High lifts values toward full selection (decelerating arrival).
    expect(ramp({ easeHigh: v(100) })).toBeGreaterThan(linear);
    // Positive Ease Low lowers values near zero (decelerating departure).
    expect(ramp({ easeLow: v(100) })).toBeLessThan(linear);
    // Negative values sharpen the corresponding end.
    expect(ramp({ easeHigh: v(-100) })).toBeLessThan(linear);
    expect(ramp({ easeLow: v(-100) })).toBeGreaterThan(linear);
  });

  it("shifts expression selector time by Time Offset", () => {
    let seen = Number.NaN;
    evaluateTextSelector(
      {
        id: "offset-expression",
        name: "Expression Selector 1",
        kind: "expression",
        enabled: true,
        mode: "add",
        amount: v(100),
        basedOn: "characters",
        expression: "time",
        timeOffset: v(2.5),
      },
      unit(0),
      {
        time: 5,
        evaluateExpression: (_source, context) => {
          seen = context.time;
          return 0;
        },
      },
    );
    expect(seen).toBe(2.5);
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
      evaluateTextSelector(
        range({ basedOn: "words", units: "index", start: v(1), end: v(2) }),
        unit(8),
        { time: 0 },
      ),
    ).toBe(1);
  });

  it("evaluates keyframed selector controls at the addressed time", () => {
    const selector = range({ end: animated(20, 100) });
    expect(evaluateTextSelector(selector, unit(7), { time: 0 })).toBe(0);
    expect(evaluateTextSelector(selector, unit(7), { time: 1 })).toBe(1);
  });

  it("randomizes range order deterministically without changing membership count", () => {
    const selector = range({ randomizeOrder: true, randomSeed: 42, end: v(30) });
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
      name: "Wiggly Selector 1",
      enabled: true,
      kind: "wiggly",
      mode: "add",
      amount: v(100),
      basedOn: "characters",
      minimumAmount: v(-100),
      maximumAmount: v(100),
      wigglesPerSecond: v(2),
      correlation: v(0),
      temporalPhase: v(0),
      spatialPhase: v(1),
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
      name: "Expression Selector 1",
      enabled: true,
      kind: "expression" as const,
      mode: "intersect" as const,
      amount: v(100),
      basedOn: "characters" as const,
      expression: "textIndex / textTotal",
    };
    expect(
      evaluateTextSelectors([range({ end: v(100) }), expression], unit(4), {
        time: 2,
        evaluateExpression: (_source, context) =>
          (context.textIndex / context.textTotal) * context.selectorValue,
      }),
    ).toBeCloseTo(0.5);
  });

  it("applies Amount to an expression result without changing selectorValue", () => {
    let upstream = 0;
    expect(
      evaluateTextSelector(
        {
          id: "expression-amount",
          name: "Expression Selector 1",
          enabled: true,
          mode: "add",
          kind: "expression",
          basedOn: "characters",
          amount: v(25),
          expression: "100",
        },
        unit(0),
        {
          time: 0,
          selectorValue: 80,
          evaluateExpression: (_expression, context) => {
            upstream = context.selectorValue;
            return 100;
          },
        },
      ),
    ).toBe(0.25);
    expect(upstream).toBe(80);
  });

  it("inverts a lone subtract selector and passes the previous selector value downstream", () => {
    expect(
      evaluateTextSelectors([range({ mode: "subtract", end: v(50) })], unit(1), { time: 0 }),
    ).toBe(0);
    expect(
      evaluateTextSelectors([range({ mode: "subtract", end: v(50) })], unit(8), { time: 0 }),
    ).toBe(1);
    let upstream = 0;
    evaluateTextSelectors(
      [
        range({ end: v(50) }),
        {
          id: "expression-upstream",
          name: "Expression Selector 2",
          kind: "expression",
          enabled: true,
          mode: "intersect",
          amount: v(100),
          basedOn: "characters",
          expression: "selectorValue",
        },
      ],
      unit(1),
      {
        time: 0,
        evaluateExpression: (_source, context) => {
          upstream = context.selectorValue;
          return context.selectorValue;
        },
      },
    );
    expect(upstream).toBe(100);
  });
});
