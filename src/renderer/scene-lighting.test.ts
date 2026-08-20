import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { flattenSceneLayers } from "../core/scene-evaluation";
import { buildSceneLighting } from "./scene-lighting";

describe("scene lighting uniforms", () => {
  it("uses animated light orientation, HDR color, and intensity", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const light = createLayerForComposition("light", composition);
    light.color = [0.5, 0.75, 1.5, 1];
    if (!light.light) throw new Error("Expected light settings");
    light.light.intensity = 4;
    light.transform.rotation[1] = { mode: "static", value: 90 };
    composition.layers.push(light);
    const uniforms = buildSceneLighting(flattenSceneLayers(composition, project, 0));
    expect(uniforms[0]).toBeCloseTo(1);
    expect(uniforms[2]).toBeCloseTo(0);
    expect(uniforms[3]).toBe(4);
    expect([...uniforms.slice(4, 7)]).toEqual([0.5, 0.75, 1.5]);
    expect(uniforms[11]).toBe(0);
  });

  it("packs point and spot attenuation parameters in world space", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const light = createLayerForComposition("light", composition);
    if (!light.light) throw new Error("Expected light settings");
    light.light = { kind: "spot", intensity: 5, range: 3600, coneAngle: 60 };
    light.transform.position[2] = { mode: "static", value: -800 };
    composition.layers.push(light);

    const uniforms = buildSceneLighting(flattenSceneLayers(composition, project, 0));
    expect([...uniforms.slice(8, 12)]).toEqual([
      composition.width / 2,
      composition.height / 2,
      -800,
      2,
    ]);
    expect(uniforms[12]).toBe(3600);
    expect(uniforms[13]).toBeCloseTo(Math.cos(Math.PI / 6));
  });
});
