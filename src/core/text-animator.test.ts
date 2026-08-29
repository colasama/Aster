import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { applyOperations } from "./operations";
import { createBlankProject } from "./project";
import { validateProjectDocument } from "./project-file";
import {
  clampTextAnimationTime,
  countAnimatedTextCharacters,
  createDefaultTextAnimator,
  MAX_ANIMATED_TEXT_CHARACTERS,
  normalizeTextAnimatorSettings,
} from "./text-animator";
import { createDefaultExpressionSelector } from "./text-animator-groups";

describe("AE-style text animator settings", () => {
  it("creates and normalizes bounded ordered groups", () => {
    const animator = createDefaultTextAnimator(true);
    expect(animator).toMatchObject({
      enabled: true,
      groups: [
        {
          name: "Animator 1",
          selectors: [{ kind: "range" }],
          properties: { position: [{ value: 0 }, { value: 0 }, { value: 0 }] },
        },
      ],
    });
    animator.groups[0].randomSeed = Number.POSITIVE_INFINITY;
    const normalized = normalizeTextAnimatorSettings(animator);
    expect(normalized.groups[0]?.randomSeed).toBe(0);
    expect(countAnimatedTextCharacters("👨‍👩‍👧‍👦A")).toBe(2);
    expect(countAnimatedTextCharacters("x".repeat(MAX_ANIMATED_TEXT_CHARACTERS + 100))).toBe(
      MAX_ANIMATED_TEXT_CHARACTERS,
    );
  });

  it("uses stable cache times for keyframed tracks and live times for procedural selectors", () => {
    const animator = createDefaultTextAnimator(true);
    const position = animator.groups[0]?.properties.position;
    if (!position) throw new Error("Expected position property");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 1, value: 0, interpolation: "linear" },
        { id: "b", time: 2, value: 100, interpolation: "linear" },
      ],
    };
    expect(clampTextAnimationTime(animator, 0)).toBe(1);
    expect(clampTextAnimationTime(animator, 1.5)).toBe(1.5);
    expect(clampTextAnimationTime(animator, 20)).toBe(2);

    animator.groups[0]?.selectors.push(createDefaultExpressionSelector());
    expect(clampTextAnimationTime(animator, 20)).toBe(20);
    expect(clampTextAnimationTime({ ...animator, enabled: false }, 1)).toBeUndefined();
  });

  it("creates enabled animator data for new text and normalizes editor operations", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers.push(text);
    expect(text.textAnimator?.enabled).toBe(true);

    if (!text.textAnimator) throw new Error("Expected a text animator");
    const changed = structuredClone(text.textAnimator);
    changed.groups[0].randomSeed = Number.POSITIVE_INFINITY;
    const updated = applyOperations(project, [
      { type: "setTextAnimator", layerId: text.id, textAnimator: changed },
    ]);
    const result = updated.compositions[0].layers.find((layer) => layer.id === text.id);
    expect(result?.textAnimator?.groups[0]?.randomSeed).toBe(0);
  });

  it("validates animated selector and property bounds at the project boundary", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers.push(text);
    expect(validateProjectDocument(structuredClone(project))).toEqual(project);

    const selector = text.textAnimator?.groups[0]?.selectors[0];
    if (!selector) throw new Error("Expected a text selector");
    selector.amount = { mode: "static", value: 101 };
    expect(() => validateProjectDocument(project)).toThrow(
      "textAnimator.groups[0].selectors[0].amount values must be between -100 and 100",
    );
  });
});
