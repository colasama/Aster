import { describe, expect, it } from "vitest";
import { staticValue } from "../types";
import {
  evaluateTextAnimatorStack,
  MAX_TEXT_ANIMATOR_GROUPS,
  segmentTextLayoutUnits,
  type TextAnimatorGroup,
} from "./text-animator-stack";
import type { TextRangeSelector } from "./text-selectors";

const v = staticValue;
const v2 = (x: number, y: number) => [v(x), v(y)] as const;
const v3 = (x: number, y: number, z: number) => [v(x), v(y), v(z)] as const;
const color = (red: number, green: number, blue: number, alpha: number) =>
  [v(red), v(green), v(blue), v(alpha)] as const;

const fullRange: TextRangeSelector = {
  id: "all",
  name: "Range Selector 1",
  kind: "range",
  enabled: true,
  mode: "add",
  amount: v(100),
  basedOn: "characters",
  units: "percentage",
  start: v(0),
  end: v(100),
  offset: v(0),
  shape: "square",
  smoothness: v(100),
  easeHigh: v(0),
  easeLow: v(0),
  randomizeOrder: false,
  randomSeed: 1,
};

describe("text animator stacks", () => {
  it("segments graphemes once for character, word, and line selector domains", () => {
    const units = segmentTextLayoutUnits("👨‍👩‍👧‍👦 A\r\nBlue sky");
    expect(segmentTextLayoutUnits("👨‍👩‍👧‍👦 A\r\nBlue sky")).toBe(units);
    expect(units.map((unit) => unit.text)).toEqual([
      "👨‍👩‍👧‍👦",
      " ",
      "A",
      "B",
      "l",
      "u",
      "e",
      " ",
      "s",
      "k",
      "y",
    ]);
    expect(units[0]).toMatchObject({
      characterIndex: 0,
      characterCount: 11,
      characterExcludingSpacesIndex: 0,
      characterExcludingSpacesCount: 9,
      wordIndex: 0,
      wordCount: 3,
      lineIndex: 0,
      lineCount: 2,
    });
    expect(units[1]).toMatchObject({ isWhitespace: true });
    expect(units[3]).toMatchObject({ wordIndex: 1, lineIndex: 1 });
    expect(units[8]).toMatchObject({ wordIndex: 2, lineIndex: 1 });
  });

  it("stacks selected animator transforms in order with neutral values", () => {
    const unit = segmentTextLayoutUnits("A")[0];
    if (!unit) throw new Error("Expected one layout unit");
    const animators: TextAnimatorGroup[] = [
      {
        id: "entrance",
        name: "Entrance",
        enabled: true,
        randomSeed: 1,
        selectors: [fullRange],
        properties: {
          position: [...v3(40, -20, 5)],
          scale: [...v3(50, 200, 100)],
          rotation: [...v3(0, 0, 30)],
          opacity: v(50),
          tracking: v(8),
          blur: [...v2(3, 4)],
          fillColor: [...color(1, 0, 0, 1)],
        },
      },
      {
        id: "secondary",
        name: "Secondary",
        enabled: true,
        randomSeed: 2,
        selectors: [],
        properties: {
          position: [...v3(10, 0, 0)],
          scale: [...v3(200, 50, 100)],
          opacity: v(50),
        },
      },
    ];
    expect(
      evaluateTextAnimatorStack(animators, unit, {
        time: 3,
        baseStyle: { fillColor: [0, 0, 1, 1], opacity: 1, codePoint: 65 },
      }),
    ).toMatchObject({
      position: [50, -20, 5],
      scale: [1, 1, 1],
      rotation: [0, 0, 30],
      opacity: 0.25,
      tracking: 8,
      blur: [3, 4],
      fillColor: [1, 0, 0, 1],
      codePoint: 65,
    });
  });

  it("passes time and one-based indices into bounded expression selectors", () => {
    const unit = segmentTextLayoutUnits("AB")[1];
    if (!unit) throw new Error("Expected a second layout unit");
    const evaluated = evaluateTextAnimatorStack(
      [
        {
          id: "expression",
          name: "Expression",
          enabled: true,
          randomSeed: 4,
          selectors: [
            {
              id: "expression-selector",
              name: "Expression Selector 1",
              kind: "expression",
              enabled: true,
              mode: "add",
              amount: v(100),
              basedOn: "characters",
              expression: "textIndex / textTotal",
            },
          ],
          properties: { position: [...v3(100, 0, 0)] },
        },
      ],
      unit,
      {
        time: 1.25,
        evaluateExpression: (_expression, context) => {
          expect(context).toEqual({ textIndex: 2, textTotal: 2, selectorValue: 100, time: 1.25 });
          return 50;
        },
      },
    );
    expect(evaluated.position).toEqual([50, 0, 0]);
  });

  it("evaluates animator property keyframes at the addressed time", () => {
    const unit = segmentTextLayoutUnits("A")[0];
    if (!unit) throw new Error("Expected one layout unit");
    const position = {
      mode: "animated" as const,
      keyframes: [
        { id: "start", time: 0, value: 0, interpolation: "linear" as const },
        { id: "end", time: 1, value: 100, interpolation: "linear" as const },
      ],
    };
    const result = evaluateTextAnimatorStack(
      [
        {
          id: "animated",
          name: "Animated",
          enabled: true,
          randomSeed: 0,
          selectors: [],
          properties: { position: [position, v(0), v(0)] },
        },
      ],
      unit,
      { time: 0.5 },
    );
    expect(result.position).toEqual([50, 0, 0]);
  });

  it("bounds work, invalid values, opacity, blur, and Unicode output", () => {
    const unit = segmentTextLayoutUnits("x")[0];
    if (!unit) throw new Error("Expected one layout unit");
    const animator: TextAnimatorGroup = {
      id: "invalid",
      name: "Invalid",
      enabled: true,
      randomSeed: 0,
      selectors: [],
      properties: {
        opacity: v(-100),
        blur: [...v2(-10, Number.NaN)],
        characterValue: v(0xd800),
        characterRange: "fullUnicode",
      },
    };
    expect(
      evaluateTextAnimatorStack(
        Array.from({ length: MAX_TEXT_ANIMATOR_GROUPS + 4 }, () => animator),
        unit,
        { time: Number.NaN },
      ),
    ).toMatchObject({ opacity: 0, blur: [0, 0], codePoint: 0xfffd });
  });

  it("preserves Latin case and digits or spans Full Unicode for character changes", () => {
    const units = segmentTextLayoutUnits("Az9a");
    const group = (properties: TextAnimatorGroup["properties"]): TextAnimatorGroup => ({
      id: "characters",
      name: "Characters",
      enabled: true,
      randomSeed: 0,
      selectors: [],
      properties,
    });
    const codePoint = (index: number, animator: TextAnimatorGroup) => {
      const unit = units[index];
      if (!unit) throw new Error("Expected character layout unit");
      return evaluateTextAnimatorStack([animator], unit, {
        time: 0,
        baseStyle: { codePoint: unit.codePoint },
      }).codePoint;
    };
    const preserved = group({
      characterOffset: v(3),
      characterRange: "preserveCaseAndDigits",
    });
    expect(String.fromCodePoint(codePoint(0, preserved))).toBe("D");
    expect(String.fromCodePoint(codePoint(1, preserved))).toBe("c");
    expect(String.fromCodePoint(codePoint(2, preserved))).toBe("2");

    const preserveValue = group({
      characterValue: v(65),
      characterRange: "preserveCaseAndDigits",
    });
    expect(String.fromCodePoint(codePoint(3, preserveValue))).toBe("a");
    const fullUnicode = group({ characterValue: v(65), characterRange: "fullUnicode" });
    expect(String.fromCodePoint(codePoint(3, fullUnicode))).toBe("A");
  });
});
