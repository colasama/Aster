import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { flattenSceneLayers } from "../scene/scene-evaluation";
import { transformPoint } from "../scene/transform-matrix";
import { staticValue } from "../types";
import { createCompositionReference } from "./composition-source";
import { createBlankComposition, createBlankProject } from "./project";
import { cloneCurrentProjectDocument } from "./project-schema";

function fixture() {
  const project = createBlankProject();
  const root = project.compositions[0];
  const source = createBlankComposition("Source");
  source.width = 640;
  source.height = 360;
  project.compositions.push(source);
  return { project, root, source };
}

describe("composition sources", () => {
  it("creates transparent empty compositions and frame-snapped references", () => {
    const { project, root, source } = fixture();
    expect(root.layers).toEqual([]);
    const layer = createCompositionReference(project, root, source.id, 1.004);
    expect(layer).toMatchObject({
      size: [640, 360],
      inPoint: 1,
      timeOffset: 0,
      collapseTransformations: false,
      audioEnabled: true,
    });
    expect(
      layer.transform.anchor.map((channel) =>
        channel.mode === "static" ? channel.value : undefined,
      ),
    ).toEqual([320, 180, 0]);
  });

  it("rejects direct and indirect cycles before mutating the destination", () => {
    const { project, root, source } = fixture();
    expect(() => createCompositionReference(project, root, root.id, 0)).toThrow("Recursive");
    source.layers.push(createCompositionReference(project, source, root.id, 0));
    expect(() => createCompositionReference(project, root, source.id, 0)).toThrow("Recursive");
    expect(root.layers).toEqual([]);
  });

  it("isolates normal references and preserves source time without clamping outside frames", () => {
    const { project, root, source } = fixture();
    const wrapper = createCompositionReference(project, root, source.id, 2);
    root.layers = [wrapper];
    wrapper.timeOffset = 1;
    wrapper.timeStretch = 2;
    expect(flattenSceneLayers(root, project, 4)[0].precompositionSurface?.time).toBe(2);
    for (const time of [-1, source.duration]) {
      wrapper.timeRemap = staticValue(time);
      expect(flattenSceneLayers(root, project, 4)).toEqual([]);
    }
  });

  it("composes nonuniform scale and rotation without losing shear or parent depth", () => {
    const { project, root, source } = fixture();
    const shape = createLayerForComposition("shape", source);
    shape.transform.position = [staticValue(100), staticValue(70), staticValue(0)];
    shape.transform.rotation[2] = staticValue(45);
    source.layers = [shape];
    const wrapper = createCompositionReference(project, root, source.id, 0);
    wrapper.collapseTransformations = true;
    wrapper.threeDimensional = true;
    wrapper.transform.scale[0] = staticValue(200);
    wrapper.transform.anchor = [staticValue(0), staticValue(0), staticValue(0)];
    wrapper.transform.position = [staticValue(0), staticValue(0), staticValue(0)];
    root.layers = [wrapper];
    const [scene] = flattenSceneLayers(root, project, 0);
    expect(scene.layer.threeDimensional).toBe(true);
    if (!scene.worldMatrix) throw new Error("Missing composed matrix");
    const anchor = scene.transform.anchor;
    const center = transformPoint(scene.worldMatrix, anchor);
    const corner = transformPoint(scene.worldMatrix, [anchor[0] + 10, anchor[1], 0]);
    expect(center).toEqual([200, 70, 0]);
    expect(corner[0] - center[0]).toBeCloseTo(Math.sqrt(2) * 10);
    expect(corner[1] - center[1]).toBeCloseTo(Math.sqrt(2) * 5);
  });

  it("migrates legacy wrappers to the new isolated semantics without removing explicit backgrounds", () => {
    const { project, root, source } = fixture();
    source.layers = [createLayerForComposition("solid", source)];
    root.layers = [createCompositionReference(project, root, source.id, 0)];
    const old = { ...project, schemaVersion: 10 };
    const migrated = cloneCurrentProjectDocument(old) as unknown as typeof project;
    expect(migrated.schemaVersion).toBe(11);
    expect(migrated.compositions[0].layers[0].collapseTransformations).toBe(false);
    expect(migrated.compositions[1].layers).toEqual(source.layers);
    expect(old.schemaVersion).toBe(10);
  });
});
