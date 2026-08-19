import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import { buildSceneGeometry, FLOATS_PER_VERTEX } from "./geometry";

describe("GPU scene geometry", () => {
  it("projects 3D rotation and depth into screen-space vertices", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    composition.layers = [mesh];
    const flat = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0)).data;
    mesh.transform.rotation[0] = { mode: "static", value: 58 };
    mesh.transform.position[2] = { mode: "static", value: 480 };
    const projected = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
    ).data;
    expect(projected[0]).not.toBeCloseTo(flat[0]);
    expect(projected[1]).not.toBeCloseTo(flat[1]);
    expect(projected[FLOATS_PER_VERTEX - 1]).toBe(0);
  });

  it("uses the circular mask only for square shape layers", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const ellipse = createLayerForComposition("shape", composition);
    ellipse.size = [480, 480];
    composition.layers = [ellipse];
    const data = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0)).data;
    expect(data[FLOATS_PER_VERTEX - 1]).toBe(1);
  });
});
