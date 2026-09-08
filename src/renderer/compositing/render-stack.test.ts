import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { createParticleLayerForComposition } from "../../core/scene/bundled-particle";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { buildSceneGeometry } from "../geometry/geometry";
import { planSceneRenderStack } from "./render-stack";

describe("scene render-stack planning", () => {
  it("keeps adjacent 3D layers depth-tested and resets depth at a 2D overlay", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const back = createLayerForComposition("shape", composition);
    const front = createLayerForComposition("shape", composition);
    back.threeDimensional = front.threeDimensional = true;
    const overlay = createLayerForComposition("solid", composition);
    const next3D = createLayerForComposition("shape", composition);
    next3D.threeDimensional = true;
    const title = createLayerForComposition("text", composition);
    composition.layers = [title, next3D, overlay, front, back];
    const scene = flattenSceneLayers(composition, project, 0);
    const geometry = buildSceneGeometry(composition, scene);
    const stack = planSceneRenderStack(scene, geometry.batches);
    expect(stack.map((item) => item.clearDepth ?? false)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("omits null layers and their effects from the GPU stack", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const nullLayer = createLayerForComposition("null", composition);
    nullLayer.effects = [
      { id: "null-effect", type: "glow", name: "Glow", enabled: true, parameters: {} },
    ];
    composition.layers = [nullLayer];
    const scene = flattenSceneLayers(composition, project, 0);
    const geometry = buildSceneGeometry(composition, scene);
    expect(planSceneRenderStack(scene, geometry.batches)).toEqual([]);
    expect(geometry.batches).toEqual([]);
  });

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

  it("keeps scene generators at their stack position without fake geometry", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const generator = createParticleLayerForComposition(composition);
    const adjustment = createLayerForComposition("adjustment", composition);
    composition.layers = [adjustment, generator, composition.layers[0]];

    const scene = flattenSceneLayers(composition, project, 0);
    const geometry = buildSceneGeometry(composition, scene);
    const stack = planSceneRenderStack(scene, geometry.batches);

    expect(stack.map((item) => item.kind)).toEqual(["geometry", "generator", "adjustment"]);
    expect(geometry.batches).toHaveLength(1);
  });
});
