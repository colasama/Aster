import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { createDefaultEvaluatedCamera } from "../core/scene/camera-settings";
import { evaluateWorldTransform } from "../core/scene/scene-evaluation";
import {
  axisConstrainedWorldDelta,
  hitTestProjectedLayer3d,
  hitTestSceneLayerAtPoint,
  projectedGizmoAxes3d,
  projectLayerBounds3d,
  worldPositionToLayerPosition,
} from "./transform-3d-interaction";

describe("3D viewport interaction math", () => {
  it("projects a 3D layer at the evaluated camera depth for bounded picking", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createLayerForComposition("shape", composition);
    layer.threeDimensional = true;
    composition.layers = [layer];
    const camera = createDefaultEvaluatedCamera(composition.width, composition.height);
    const projected = projectLayerBounds3d(
      layer,
      evaluateWorldTransform(layer, composition, 0),
      composition,
      camera,
    );

    expect(projected).toBeDefined();
    expect(projected?.cameraDepth).toBeCloseTo(camera.projection.zoom);
    expect(projected?.outline).toHaveLength(4);
    expect(projected && hitTestProjectedLayer3d(projected.origin, projected)).toBe(true);
    expect(projected && hitTestProjectedLayer3d([-100, -100], projected)).toBe(false);
  });

  it("rotates Local axes at the current transform while World axes remain fixed", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createLayerForComposition("solid", composition);
    layer.threeDimensional = true;
    layer.transform.rotation[2] = { mode: "static", value: 90 };
    const world = evaluateWorldTransform(layer, composition, 0);
    const camera = createDefaultEvaluatedCamera(composition.width, composition.height);

    const localX = projectedGizmoAxes3d(world, composition, camera, "local", 1).find(
      (axis) => axis.axis === "x",
    );
    const worldX = projectedGizmoAxes3d(world, composition, camera, "world", 1).find(
      (axis) => axis.axis === "x",
    );

    expect(localX?.basis[0]).toBeCloseTo(0, 5);
    expect(localX?.basis[1]).toBeCloseTo(1, 5);
    expect(worldX?.basis).toEqual([1, 0, 0]);
    expect(localX?.screenDirection[1]).toBeGreaterThan(0.99);
    expect(worldX?.screenDirection[0]).toBeGreaterThan(0.99);
    if (!localX) throw new Error("Expected local X axis");
    const delta = axisConstrainedWorldDelta([0, 72], localX);
    expect(delta[0]).toBeCloseTo(0, 4);
    expect(delta[1]).toBeCloseTo(72, 4);
    expect(delta[2]).toBeCloseTo(0, 4);
  });

  it("inverts parent position at the requested time without flattening animation", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const parent = createLayerForComposition("null", composition);
    const child = createLayerForComposition("shape", composition);
    parent.threeDimensional = true;
    child.threeDimensional = true;
    child.parentId = parent.id;
    parent.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 100, interpolation: "linear" },
        { id: "end", time: 2, value: 300, interpolation: "linear" },
      ],
    };
    parent.transform.position[1] = { mode: "static", value: 0 };
    parent.transform.scale[2] = { mode: "static", value: 200 };
    composition.layers = [child, parent];

    expect(worldPositionToLayerPosition(child, [250, 40, 80], composition, 1)).toEqual([
      50, 40, 40,
    ]);
  });

  it("selects a locked top layer instead of clicking through and includes 3D layers", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const bottom = createLayerForComposition("solid", composition);
    const locked = createLayerForComposition("shape", composition);
    locked.locked = true;
    composition.layers = [locked, bottom];
    const camera = createDefaultEvaluatedCamera(composition.width, composition.height);

    expect(
      hitTestSceneLayerAtPoint(
        composition,
        project,
        0,
        [composition.width / 2, composition.height / 2],
        camera,
      )?.id,
    ).toBe(locked.id);

    locked.threeDimensional = true;
    expect(
      hitTestSceneLayerAtPoint(
        composition,
        project,
        0,
        [composition.width / 2, composition.height / 2],
        camera,
      )?.id,
    ).toBe(locked.id);

    locked.transform.position[0] = {
      mode: "animated",
      keyframes: [
        {
          id: "locked-center",
          time: 0,
          value: composition.width / 2,
          interpolation: "linear",
        },
        {
          id: "locked-away",
          time: 1,
          value: composition.width * 2,
          interpolation: "linear",
        },
      ],
    };
    composition.layers = [locked];
    expect(
      hitTestSceneLayerAtPoint(
        composition,
        project,
        1,
        [composition.width / 2, composition.height / 2],
        camera,
      ),
    ).toBeUndefined();
  });
});
