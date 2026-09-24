import { describe, expect, it, vi } from "vitest";
import * as expressions from "../animation/expressions";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import { staticValue } from "../types";
import { evaluateWorldTransform, flattenSceneLayers } from "./scene-evaluation";

describe("frame-local scene evaluation reuse", () => {
  it("evaluates a shared hidden parent once and preserves animated child transforms", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const parent = createLayerForComposition("null", composition);
    parent.visible = false;
    parent.expressions = { "rotation.2": "sin(time) * 45" };
    parent.transform.scale[0] = staticValue(-125);
    const children = Array.from({ length: 20 }, (_, index) => {
      const child = createLayerForComposition("shape", composition);
      child.parentId = parent.id;
      child.transform.position[0] = staticValue(index * 10);
      return child;
    });
    composition.layers = [...children, parent];
    const evaluate = vi.spyOn(expressions, "evaluateLayerTransform");
    try {
      const scene = flattenSceneLayers(composition, project, 0.7);
      expect(evaluate).toHaveBeenCalledTimes(21);
      expect(scene.map((entry) => entry.transform)).toEqual(
        children.map((child) => evaluateWorldTransform(child, composition, 0.7)),
      );
    } finally {
      evaluate.mockRestore();
    }
  });

  it("shares repeated sources at the same time and keeps different source times separate", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const source = { ...structuredClone(composition), id: "repeated-source" };
    const child = createLayerForComposition("shape", source);
    child.expressions = { "position.0": "value + time * 100" };
    source.layers = [child];
    project.compositions.push(source);
    composition.layers = [0, 0, 0.0000001].map((offset) => {
      const wrapper = createLayerForComposition("precomposition", composition);
      wrapper.sourceCompositionId = source.id;
      wrapper.timeOffset = offset;
      return wrapper;
    });
    const evaluate = vi.spyOn(expressions, "evaluateLayerTransform");
    try {
      const scene = flattenSceneLayers(composition, project, 1);
      const childCalls = evaluate.mock.calls.filter(([layer]) => layer === child);
      expect(childCalls.map(([, time]) => time)).toEqual([1, 1.0000001]);
      expect(scene).toHaveLength(3);
      expect(new Set(scene.map((entry) => entry.instanceId)).size).toBe(3);
      expect(scene[0].transform).toEqual(scene[1].transform);
      expect(scene[2].transform.position[0]).not.toBe(scene[0].transform.position[0]);
    } finally {
      evaluate.mockRestore();
    }
  });

  it("does not reuse values across calls after edits, reparenting or time changes", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const parent = createLayerForComposition("null", composition);
    const child = createLayerForComposition("shape", composition);
    child.parentId = parent.id;
    parent.expressions = { "position.0": "value + time * 100" };
    composition.layers = [child, parent];
    const first = flattenSceneLayers(composition, project, 0)[0].transform;
    expect(flattenSceneLayers(composition, project, 1)[0].transform).not.toEqual(first);
    parent.transform.position[0] = staticValue(12);
    expect(flattenSceneLayers(composition, project, 0)[0].transform).toEqual(
      evaluateWorldTransform(child, composition, 0),
    );
    child.parentId = "missing-parent";
    expect(flattenSceneLayers(composition, project, 0)[0].transform).toEqual(
      expressions.evaluateLayerTransform(child, 0),
    );
  });

  it("preserves finite root-relative results for malformed parent cycles", () => {
    const composition = createBlankProject().compositions[0];
    const a = createLayerForComposition("shape", composition);
    const b = createLayerForComposition("shape", composition);
    const c = createLayerForComposition("shape", composition);
    a.parentId = b.id;
    b.parentId = a.id;
    c.parentId = a.id;
    composition.layers = [c, b, a];
    expect(flattenSceneLayers(composition, undefined, 0).map((entry) => entry.transform)).toEqual(
      composition.layers.map((layer) => evaluateWorldTransform(layer, composition, 0)),
    );
  });
});
