import { describe, expect, it } from "vitest";
import {
  evaluateTextAnimatorStack,
  MAX_TEXT_ANIMATOR_GROUPS,
  segmentTextLayoutUnits,
  type TextAnimatorGroup,
} from "./text-animator-stack";
import type { TextRangeSelector } from "./text-selectors";

const fullRange: TextRangeSelector = {
  id: "all",
  kind: "range",
  enabled: true,
  mode: "add",
  amount: 100,
  basedOn: "characters",
  units: "percentage",
  start: 0,
  end: 100,
  offset: 0,
  shape: "square",
  smoothness: 100,
  easeHigh: 0,
  easeLow: 0,
  randomizeOrder: false,
  randomSeed: 1,
};

describe("text animator stacks", () => {
  it("segments graphemes once for character, word, and line selector domains", () => {
    const units = segmentTextLayoutUnits("👨‍👩‍👧‍👦 A\r\nBlue sky");
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

  it("stacks selected animator transforms in order with AE neutral values", () => {
    const unit = segmentTextLayoutUnits("A")[0];
    if (!unit) throw new Error("Expected one layout unit");
    const animators: TextAnimatorGroup[] = [
      {
        id: "entrance",
        enabled: true,
        randomSeed: 1,
        selectors: [fullRange],
        properties: {
          position: [40, -20, 5],
          scale: [50, 200, 100],
          rotation: [0, 0, 30],
          opacity: 50,
          tracking: 8,
          blur: [3, 4],
          fillColor: [1, 0, 0, 1],
        },
      },
      {
        id: "secondary",
        enabled: true,
        randomSeed: 2,
        selectors: [],
        properties: { position: [10, 0, 0], scale: [200, 50, 100], opacity: 50 },
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
          enabled: true,
          randomSeed: 4,
          selectors: [
            {
              id: "expression-selector",
              kind: "expression",
              enabled: true,
              mode: "add",
              amount: 100,
              basedOn: "characters",
              expression: "textIndex / textTotal",
            },
          ],
          properties: { position: [100, 0, 0] },
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

  it("bounds work, invalid values, opacity, blur, and Unicode output", () => {
    const unit = segmentTextLayoutUnits("x")[0];
    if (!unit) throw new Error("Expected one layout unit");
    const animator: TextAnimatorGroup = {
      id: "invalid",
      enabled: true,
      randomSeed: 0,
      selectors: [],
      properties: {
        opacity: -100,
        blur: [-10, Number.NaN],
        characterValue: 0xd800,
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
});
