import { describe, expect, it } from "vitest";
import {
  createDefaultExpressionSelector,
  createDefaultTextAnimatorGroup,
  createDefaultWigglySelector,
  duplicateTextAnimatorGroup,
  duplicateTextSelector,
  MAX_TEXT_SELECTORS_PER_GROUP,
  normalizeTextAnimatorGroups,
} from "./text-animator-groups";
import type { TextAnimatorGroup } from "./text-animator-stack";
import { MAX_TEXT_ANIMATOR_GROUPS } from "./text-animator-stack";

describe("text animator group defaults and normalization", () => {
  it("creates selector defaults", () => {
    const group = createDefaultTextAnimatorGroup(2);
    expect(group.name).toBe("Animator 3");
    expect(group.properties.position).toEqual([
      { mode: "static", value: 0 },
      { mode: "static", value: 0 },
      { mode: "static", value: 0 },
    ]);
    expect(group.selectors[0]).toMatchObject({
      kind: "range",
      name: "Range Selector 1",
      mode: "add",
      basedOn: "characters",
      units: "percentage",
      start: { mode: "static", value: 0 },
      end: { mode: "static", value: 100 },
      shape: "square",
    });
    expect(createDefaultWigglySelector()).toMatchObject({
      kind: "wiggly",
      mode: "add",
      minimumAmount: { mode: "static", value: -100 },
      maximumAmount: { mode: "static", value: 100 },
    });
    expect(createDefaultExpressionSelector().expression).toBe(
      "selectorValue * textIndex / textTotal",
    );
  });

  it("bounds group counts, selector counts, values, names, and duplicate ids", () => {
    const source = Array.from({ length: MAX_TEXT_ANIMATOR_GROUPS + 2 }, (_, groupIndex) => ({
      ...createDefaultTextAnimatorGroup(groupIndex),
      id: "duplicate",
      name: " ".repeat(4),
      randomSeed: Number.POSITIVE_INFINITY,
      selectors: Array.from({ length: MAX_TEXT_SELECTORS_PER_GROUP + 2 }, () => ({
        ...createDefaultWigglySelector(),
        id: "selector",
        amount: 999,
        wigglesPerSecond: Number.NaN,
      })),
      properties: {
        opacity: -50,
        lineAnchor: 150,
        characterOffset: 2,
        scale: [Number.NaN, 50_000, -50_000] as [number, number, number],
        fillColor: [-1, 0.25, 2, Number.NaN] as [number, number, number, number],
      },
    }));

    const normalized = normalizeTextAnimatorGroups(source as unknown as TextAnimatorGroup[]);
    expect(normalized).toHaveLength(MAX_TEXT_ANIMATOR_GROUPS);
    expect(new Set(normalized.map((group) => group.id)).size).toBe(MAX_TEXT_ANIMATOR_GROUPS);
    expect(normalized[0]).toMatchObject({
      name: "Animator 1",
      randomSeed: 0,
      properties: {
        opacity: { mode: "static", value: 0 },
        lineAnchor: { mode: "static", value: 100 },
        characterOffset: { mode: "static", value: 2 },
        characterRange: "preserveCaseAndDigits",
        scale: [
          { mode: "static", value: 100 },
          { mode: "static", value: 10_000 },
          { mode: "static", value: -10_000 },
        ],
        fillColor: [
          { mode: "static", value: 0 },
          { mode: "static", value: 0.25 },
          { mode: "static", value: 1 },
          { mode: "static", value: 0 },
        ],
      },
    });
    expect(normalized[0]?.selectors).toHaveLength(MAX_TEXT_SELECTORS_PER_GROUP);
    expect(new Set(normalized[0]?.selectors.map((selector) => selector.id)).size).toBe(
      MAX_TEXT_SELECTORS_PER_GROUP,
    );
    expect(normalized[0]?.selectors[0]).toMatchObject({
      name: "Wiggly Selector 1",
      amount: { mode: "static", value: 100 },
      wigglesPerSecond: { mode: "static", value: 2 },
    });
  });

  it("duplicates groups and selectors with independent nested tracks and fresh ids", () => {
    const source = createDefaultTextAnimatorGroup();
    const sourceSelector = source.selectors[0];
    const sourcePositionVector = source.properties.position;
    if (!sourceSelector || !sourcePositionVector)
      throw new Error("Expected default animator fixtures");
    sourceSelector.amount = {
      mode: "animated",
      keyframes: [
        {
          id: "selector-keyframe",
          time: 0,
          value: 50,
          interpolation: "bezier",
          easing: [0.2, 0.3, 0.7, 0.8],
        },
      ],
    };
    sourcePositionVector[0] = {
      mode: "animated",
      keyframes: [{ id: "property-keyframe", time: 0, value: 20, interpolation: "linear" }],
    };
    const sourcePosition = sourcePositionVector[0];

    const duplicate = duplicateTextAnimatorGroup(source);
    const duplicatedSelector = duplicate.selectors[0];
    const duplicatedPosition = duplicate.properties.position?.[0];
    if (!duplicatedSelector || !duplicatedPosition)
      throw new Error("Expected duplicated animator fixtures");
    const duplicatedAmount = duplicatedSelector.amount;
    const sourceAmount = sourceSelector.amount;

    expect(duplicate.name).toBe("Animator 1 Copy");
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicatedSelector.id).not.toBe(sourceSelector.id);
    expect(duplicate.selectors).not.toBe(source.selectors);
    expect(duplicate.properties).not.toBe(source.properties);
    expect(duplicatedAmount).not.toBe(sourceAmount);
    expect(duplicatedPosition).not.toBe(sourcePosition);
    if (
      duplicatedAmount.mode !== "animated" ||
      sourceAmount.mode !== "animated" ||
      duplicatedPosition.mode !== "animated" ||
      sourcePosition.mode !== "animated"
    )
      throw new Error("Expected animated duplicate fixtures");
    expect(duplicatedAmount.keyframes[0]?.id).not.toBe(sourceAmount.keyframes[0]?.id);
    expect(duplicatedPosition.keyframes[0]?.id).not.toBe(sourcePosition.keyframes[0]?.id);
    expect(duplicatedAmount.keyframes[0]?.easing).not.toBe(sourceAmount.keyframes[0]?.easing);
    const duplicatedAmountKeyframe = duplicatedAmount.keyframes[0];
    const duplicatedPositionKeyframe = duplicatedPosition.keyframes[0];
    if (!duplicatedAmountKeyframe || !duplicatedPositionKeyframe)
      throw new Error("Expected duplicated keyframes");
    duplicatedAmountKeyframe.value = 75;
    duplicatedPositionKeyframe.value = 40;
    expect(sourceAmount.keyframes[0]?.value).toBe(50);
    expect(sourcePosition.keyframes[0]?.value).toBe(20);

    const selectorCopy = duplicateTextSelector(sourceSelector);
    expect(selectorCopy.name).toBe("Range Selector 1 Copy");
    expect(selectorCopy.id).not.toBe(sourceSelector.id);
    expect(selectorCopy.amount).not.toBe(sourceSelector.amount);
  });
});
