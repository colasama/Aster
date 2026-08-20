import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import { buildSceneGeometry } from "./geometry";
import { planSceneRenderStack } from "./render-stack";

describe("scene render-stack planning", () => {
  it("routes lower geometry, adjustment, then upper geometry", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const lower = composition.layers[0];
    lower.name = "Lower";
    const adjustment = createLayerForComposition("adjustment", composition);
    const upper = createLayerForComposition("shape", composition);
    upper.name = "Upper";
    composition.layers = [upper, adjustment, lower];

    const scene = flattenSceneLayers(composition, project, 0);
    const geometry = buildSceneGeometry(composition, scene);
    const stack = planSceneRenderStack(scene, geometry.batches);

    expect(stack.map((item) => item.kind)).toEqual(["geometry", "adjustment", "geometry"]);
    expect(
      stack.map((item) =>
        item.kind === "geometry" ? item.batch.layer.name : item.scene.layer.name,
      ),
    ).toEqual(["Lower", "Adjustment Layer", "Upper"]);
    expect(geometry.batches.map((batch) => batch.layer.name)).toEqual(["Lower", "Upper"]);
  });

  it("keeps particles at their stack position without fake geometry", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const particle = createLayerForComposition("particle", composition);
    const adjustment = createLayerForComposition("adjustment", composition);
    composition.layers = [adjustment, particle, composition.layers[0]];

    const scene = flattenSceneLayers(composition, project, 0);
    const geometry = buildSceneGeometry(composition, scene);
    const stack = planSceneRenderStack(scene, geometry.batches);

    expect(stack.map((item) => item.kind)).toEqual(["geometry", "particle", "adjustment"]);
    expect(geometry.batches).toHaveLength(1);
  });
});
