import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { createParticleLayerForComposition } from "../scene/bundled-particle";
import { flattenSceneLayers } from "../scene/scene-evaluation";
import { precomposeLayers } from "./precomposition";
import { createBlankProject, createDemoProject } from "./project";

describe("precomposition creation", () => {
  it("routes precomposed adjustment layers through an isolated texture surface", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const adjustment = createLayerForComposition("adjustment", composition);
    composition.layers.unshift(adjustment);

    const result = precomposeLayers(project, [adjustment.id]);
    expect(result).toBeDefined();
    const wrapper = result?.project.compositions[0].layers.find(
      (layer) => layer.id === result.wrapperId,
    );
    expect(wrapper).toMatchObject({
      kind: "precomposition",
      threeDimensional: false,
      color: [1, 1, 1, 1],
    });
  });

  it("moves GPU scene generators into nested precompositions", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const particle = createParticleLayerForComposition(composition);
    composition.layers.unshift(particle);

    const result = precomposeLayers(project, [particle.id]);
    const nested = result?.project.compositions.find(
      (composition) => composition.id === result.nestedCompositionId,
    );
    expect(nested?.layers[0].kind).toBe("generator");
    expect(result?.project.compositions[0].layers[0].threeDimensional).toBe(false);
  });

  it("preserves evaluated appearance and stacking at the same project time", () => {
    const project = createDemoProject();
    const source = project.compositions[0];
    const layer = source.layers[0];
    const time = 0.72;
    const before = flattenSceneLayers(source, project, time).find(
      (scene) => scene.layer.id === layer.id,
    );
    const originalIndex = source.layers.findIndex((candidate) => candidate.id === layer.id);

    const result = precomposeLayers(project, [layer.id]);
    expect(result).toBeDefined();
    if (!result) return;
    const root = result.project.compositions[0];
    const surface = flattenSceneLayers(root, result.project, time).find(
      (scene) => scene.layer.id === result.wrapperId,
    )?.precompositionSurface;
    if (!surface) throw new Error("Missing isolated surface");
    const after = flattenSceneLayers(surface.composition, result.project, surface.time).find(
      (scene) => scene.layer.id === layer.id,
    );
    expect(root.layers.findIndex((candidate) => candidate.id === result.wrapperId)).toBe(
      originalIndex,
    );
    expect(after?.transform.position).toEqual(before?.transform.position);
    expect(after?.transform.opacity).toBeCloseTo(before?.transform.opacity ?? 0);
  });

  it("removes parent references that would cross the composition boundary", () => {
    const project = createDemoProject();
    const source = project.compositions[0];
    const parent = source.layers[0];
    const child = source.layers[1];
    child.parentId = parent.id;
    const result = precomposeLayers(project, [child.id]);
    expect(result).toBeDefined();
    const nested = result?.project.compositions.find(
      (composition) => composition.id === result.nestedCompositionId,
    );
    expect(nested?.layers[0].parentId).toBeUndefined();
  });
});
