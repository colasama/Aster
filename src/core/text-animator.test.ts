import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { applyOperations } from "./operations";
import { createBlankProject } from "./project";
import { validateProjectDocument } from "./project-file";
import {
  clampTextAnimationTime,
  countAnimatedTextCharacters,
  createDefaultTextAnimator,
  evaluateTextCharacter,
  MAX_ANIMATED_TEXT_CHARACTERS,
  normalizeTextAnimatorSettings,
} from "./text-animator";

describe("per-character text animation", () => {
  it("resolves position, opacity, and scale with a per-character stagger", () => {
    const animator = {
      ...createDefaultTextAnimator(true),
      stagger: 0.5,
      duration: 1,
      position: [40, 80] as [number, number],
      scale: 50,
      opacity: 0,
    };

    expect(evaluateTextCharacter(animator, 0, 0)).toMatchObject({
      position: [40, 80],
      scale: 0.5,
      opacity: 0,
      progress: 0,
    });
    expect(evaluateTextCharacter(animator, 0.5, 1)).toMatchObject({
      position: [40, 80],
      scale: 0.5,
      opacity: 0,
      progress: 0,
    });
    expect(evaluateTextCharacter(animator, 0.5, 0)).toMatchObject({
      position: [5, 10],
      scale: 0.9375,
      opacity: 0.875,
      progress: 0.875,
    });
    expect(evaluateTextCharacter(animator, 1.5, 1)).toMatchObject({
      position: [0, 0],
      scale: 1,
      opacity: 1,
      progress: 1,
    });
  });

  it("bounds persisted settings and caps animation work", () => {
    const normalized = normalizeTextAnimatorSettings({
      enabled: true,
      delay: -100,
      stagger: 100,
      duration: 0,
      position: [-100_000, 100_000],
      scale: 10_000,
      opacity: -5,
    });
    expect(normalized).toEqual({
      enabled: true,
      delay: -60,
      stagger: 10,
      duration: 0.01,
      position: [-8192, 8192],
      scale: 1000,
      opacity: 0,
    });
    expect(countAnimatedTextCharacters("👨‍👩‍👧‍👦A")).toBe(2);
    expect(countAnimatedTextCharacters("x".repeat(MAX_ANIMATED_TEXT_CHARACTERS + 100))).toBe(
      MAX_ANIMATED_TEXT_CHARACTERS,
    );
    expect(evaluateTextCharacter(normalized, 0, MAX_ANIMATED_TEXT_CHARACTERS)).toMatchObject({
      position: [0, 0],
      scale: 1,
      opacity: 1,
    });
  });

  it("stabilizes the renderer sample after the last animated character", () => {
    const animator = { ...createDefaultTextAnimator(true), delay: 0.2, stagger: 0.1 };
    expect(clampTextAnimationTime(animator, 100, 5)).toBeCloseTo(1.1);
    expect(clampTextAnimationTime(animator, 0.4, 5)).toBe(0.4);
    expect(clampTextAnimationTime({ ...animator, enabled: false }, 1, 5)).toBeUndefined();
  });

  it("creates enabled animator data for new text and normalizes editor operations", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers.push(text);
    expect(text.textAnimator?.enabled).toBe(true);

    const updated = applyOperations(project, [
      {
        type: "setTextAnimator",
        layerId: text.id,
        textAnimator: {
          ...createDefaultTextAnimator(true),
          stagger: 99,
          position: [20_000, -20_000],
        },
      },
    ]);
    const result = updated.compositions[0].layers.find((layer) => layer.id === text.id);
    expect(result?.textAnimator).toMatchObject({ stagger: 10, position: [8192, -8192] });
  });

  it("rejects animator settings outside the project boundary", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers.push(text);
    expect(validateProjectDocument(structuredClone(project))).toEqual(project);

    if (!text.textAnimator) throw new Error("Expected a text animator");
    text.textAnimator.duration = 0;
    expect(() => validateProjectDocument(project)).toThrow(
      "textAnimator.duration must be between 0.01 and 60",
    );
  });
});
