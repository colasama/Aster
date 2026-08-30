import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import {
  createDefaultExpressionSelector,
  createDefaultTextAnimatorGroup,
  createDefaultWigglySelector,
} from "./text-animator-groups";
import {
  collectTextAnimatorTrackEntries,
  getTextAnimatorProperty,
  setTextAnimatorProperty,
  textAnimatorPropertyPath,
  textSelectorPropertyPath,
} from "./text-animator-property-paths";
import type { TextAnimatorProperties } from "./text-animator-stack";
import { staticValue } from "./types";

describe("text animator property paths", () => {
  it("enumerates every numeric animator and selector field with stable ID addressing", () => {
    const layer = textLayer();
    const group = createDefaultTextAnimatorGroup();
    group.id = "animator.with:punctuation";
    group.properties = allProperties();
    const range = group.selectors[0];
    if (!range) throw new Error("Expected range selector");
    range.id = "range.with:punctuation";
    const wiggly = createDefaultWigglySelector();
    const expression = createDefaultExpressionSelector();
    group.selectors.push(wiggly, expression);
    if (!layer.textAnimator) throw new Error("Expected text animator");
    layer.textAnimator.groups = [group];

    const entries = collectTextAnimatorTrackEntries(layer);
    const propertyEntries = entries.filter((entry) => entry.source === "property");
    const selectorEntries = entries.filter((entry) => entry.source === "selector");
    expect(propertyEntries).toHaveLength(32);
    expect(selectorEntries).toHaveLength(15);
    expect(
      propertyEntries.find((entry) => entry.field === "fillColor" && entry.component === 3)?.path,
    ).toContain("animator%2Ewith%3Apunctuation");
    expect(
      selectorEntries.find((entry) => entry.selectorId === range.id && entry.field === "offset")
        ?.path,
    ).toContain("range%2Ewith%3Apunctuation");
    expect(
      selectorEntries.filter((entry) => entry.selectorId === wiggly.id).map((entry) => entry.field),
    ).toEqual([
      "amount",
      "minimumAmount",
      "maximumAmount",
      "wigglesPerSecond",
      "correlation",
      "temporalPhase",
      "spatialPhase",
    ]);
    expect(
      selectorEntries
        .filter((entry) => entry.selectorId === expression.id)
        .map((entry) => entry.field),
    ).toEqual(["amount"]);
  });

  it("resolves paths after reorder and replaces owners to invalidate evaluation caches", () => {
    const layer = textLayer();
    const first = createDefaultTextAnimatorGroup(0);
    const second = createDefaultTextAnimatorGroup(1);
    const range = first.selectors[0];
    if (!range || !layer.textAnimator) throw new Error("Expected text animator");
    layer.textAnimator.groups = [first, second];
    const positionPath = textAnimatorPropertyPath(first.id, "position", 0);
    const rangePath = textSelectorPropertyPath(first.id, range.id, "end");
    const originalProperties = first.properties;
    const originalSelector = range;

    layer.textAnimator.groups.reverse();
    setTextAnimatorProperty(layer, positionPath, staticValue(240));
    setTextAnimatorProperty(layer, rangePath, staticValue(35));

    expect(getTextAnimatorProperty(layer, positionPath)).toEqual(staticValue(240));
    expect(getTextAnimatorProperty(layer, rangePath)).toEqual(staticValue(35));
    expect(first.properties).not.toBe(originalProperties);
    expect(first.selectors[0]).not.toBe(originalSelector);
  });
});

function textLayer() {
  const project = createBlankProject();
  return createLayerForComposition("text", project.compositions[0]);
}

function allProperties(): TextAnimatorProperties {
  const vector = (length: number, value = 0) => Array.from({ length }, () => staticValue(value));
  return {
    anchorPoint: vector(3) as TextAnimatorProperties["anchorPoint"],
    position: vector(3) as TextAnimatorProperties["position"],
    scale: vector(3, 100) as TextAnimatorProperties["scale"],
    rotation: vector(3) as TextAnimatorProperties["rotation"],
    skew: staticValue(0),
    skewAxis: staticValue(0),
    opacity: staticValue(100),
    fillColor: vector(4, 1) as TextAnimatorProperties["fillColor"],
    strokeColor: vector(4, 1) as TextAnimatorProperties["strokeColor"],
    strokeWidth: staticValue(0),
    tracking: staticValue(0),
    lineAnchor: staticValue(50),
    lineSpacing: vector(2) as TextAnimatorProperties["lineSpacing"],
    characterOffset: staticValue(0),
    characterValue: staticValue(65),
    characterRange: "preserveCaseAndDigits",
    blur: vector(2) as TextAnimatorProperties["blur"],
  };
}
