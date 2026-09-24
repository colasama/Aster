import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import { evaluateSceneCamera } from "./scene-camera";

function childWithAnimatedCamera(parent: Composition, id: string): Composition {
  const child = { ...structuredClone(parent), id };
  const camera = createLayerForComposition("camera", child);
  camera.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: "k0", time: 0, value: 0, interpolation: "linear" },
      { id: "k1", time: 4, value: 400, interpolation: "linear" },
    ],
  };
  const solid = createLayerForComposition("solid", child);
  child.layers = [solid, camera];
  return child;
}

describe("nested precomposition camera time", () => {
  it("evaluates a surfaced precomp's camera at the mapped nested time", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const child = childWithAnimatedCamera(root, "child");

    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = child.id;
    wrapper.threeDimensional = true;
    wrapper.inPoint = 2;
    wrapper.outPoint = 10;
    root.layers = [wrapper];
    project.compositions.push(child);

    const positions: number[] = [];
    for (const time of [2, 3, 4, 5, 6]) {
      const surface = flattenSceneLayers(root, project, time).find(
        (scene) => scene.precompositionSurface,
      )?.precompositionSurface;
      if (!surface) throw new Error("expected a precomposition surface");
      const evaluated = evaluateSceneCamera(child, surface.time);
      if (!evaluated) throw new Error("expected an evaluated camera");
      positions.push(evaluated.pose.position[0]);
    }
    expect(positions[0]).toBeCloseTo(0, 5);
    expect(positions[4]).toBeCloseTo(400, 5);
  });

  it("surfaces a flattened wrapper whose source contains a camera", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const child = childWithAnimatedCamera(root, "child");
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = child.id;
    root.layers = [wrapper];
    project.compositions.push(child);

    const surface = flattenSceneLayers(root, project, 1).find(
      (scene) => scene.precompositionSurface,
    )?.precompositionSurface;
    expect(surface?.composition.id).toBe("child");
  });

  it("surfaces a nested wrapper at the level that actually contains the camera", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const middle = { ...structuredClone(root), id: "middle" };
    const inner = childWithAnimatedCamera(root, "inner");

    const innerWrapper = createLayerForComposition("precomposition", middle);
    innerWrapper.sourceCompositionId = inner.id;
    middle.layers = [innerWrapper];

    const outerWrapper = createLayerForComposition("precomposition", root);
    outerWrapper.sourceCompositionId = middle.id;
    root.layers = [outerWrapper];
    project.compositions.push(middle, inner);

    const scenes = flattenSceneLayers(root, project, 1);
    const surface = scenes.find((scene) => scene.precompositionSurface);
    expect(surface?.precompositionSurface?.composition.id).toBe("inner");
    expect(scenes.filter((scene) => scene.precompositionSurface)).toHaveLength(1);
  });

  it("still flattens a wrapper whose source has no camera", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const child = { ...structuredClone(root), id: "child" };
    const solid = createLayerForComposition("solid", child);
    child.layers = [solid];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = child.id;
    root.layers = [wrapper];
    project.compositions.push(child);

    const scenes = flattenSceneLayers(root, project, 1);
    expect(scenes.some((scene) => scene.precompositionSurface)).toBe(false);
    expect(scenes.some((scene) => scene.layer.id === solid.id)).toBe(true);
  });
});
