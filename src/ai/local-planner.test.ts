import { describe, expect, it } from "vitest";
import { applyOperations } from "../core/operations";
import { createDemoProject } from "../core/project";
import { validateProjectDocument } from "../core/project-file";
import { evaluateAnimatable } from "../core/timeline";
import { planLocalAiOperations } from "./local-planner";

describe("local AI operation planner", () => {
  it("reduces elasticity with reversible layer operations", () => {
    const project = createDemoProject();
    const composition = project.compositions[0];
    const selected = composition.layers.slice(0, 2).map((layer) => layer.id);
    const plan = planLocalAiOperations("减少弹性", composition, selected, 0);
    expect(plan.operations).toEqual(selected.map((layerId) => ({ type: "easeLayer", layerId })));
    const updated = applyOperations(project, plan.operations);
    const keyframes = updated.compositions[0].layers[0].transform.position[1];
    expect(keyframes.mode).toBe("animated");
    if (keyframes.mode === "animated")
      expect(keyframes.keyframes[0].easing).toEqual([1 / 3, 0, 2 / 3, 1]);
  });

  it("keeps selected subjects clear and blurs only visible background layers", () => {
    const project = createDemoProject();
    const composition = project.compositions[0];
    const subject = composition.layers[0];
    const plan = planLocalAiOperations("人物保持清晰，背景增加景深", composition, [subject.id], 1);
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.operations.every((operation) => operation.type === "addEffect")).toBe(true);
    expect(
      plan.operations.every(
        (operation) => !("layerId" in operation) || operation.layerId !== subject.id,
      ),
    ).toBe(true);
    expect(
      plan.operations.every(
        (operation) =>
          operation.type !== "addEffect" || operation.effect.type === "camera-lens-blur",
      ),
    ).toBe(true);
  });

  it("duplicates a selection with deterministic alternating entry motion", () => {
    const project = createDemoProject();
    const composition = project.compositions[0];
    const sources = composition.layers.slice(0, 2);
    const plan = planLocalAiOperations(
      "复制这组 Layer 并改成左右交替进入",
      composition,
      sources.map((layer) => layer.id),
      2,
    );
    expect(plan.operations).toHaveLength(6);
    const additions = plan.operations.filter((operation) => operation.type === "addLayer");
    expect(additions).toHaveLength(2);
    expect(additions.map((operation) => operation.layer.id)).not.toEqual(
      sources.map((layer) => layer.id),
    );
    const starts = plan.operations.filter(
      (operation, index) => operation.type === "addKeyframe" && index % 3 === 1,
    );
    const deltas = starts.map((operation, index) =>
      operation.type === "addKeyframe"
        ? operation.keyframe.value - evaluateAnimatable(sources[index].transform.position[0], 2)
        : 0,
    );
    expect(deltas).toEqual([-240, 240]);
    validateProjectDocument(applyOperations(project, plan.operations));
  });

  it("creates quoted text without requiring an existing selection", () => {
    const project = createDemoProject();
    const plan = planLocalAiOperations("创建文字图层“GPU FIRST”", project.compositions[0], [], 3);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      type: "addLayer",
      layer: { kind: "text", text: "GPU FIRST", inPoint: 3 },
    });
  });
});
