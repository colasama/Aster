import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import {
  evaluateWorldTransform,
  flattenSceneLayers,
  visibleLayersAtTime,
} from "./scene-evaluation";

describe("editor scene evaluation", () => {
  it("combines parent transforms at arbitrary time", () => {
    const composition = createBlankProject().compositions[0];
    const parent = composition.layers[0];
    const child = structuredClone(parent);
    child.id = crypto.randomUUID();
    child.parentId = parent.id;
    child.transform.position[0] = { mode: "static", value: 10 };
    child.transform.position[1] = { mode: "static", value: 0 };
    parent.transform.position[0] = { mode: "static", value: 100 };
    parent.transform.position[1] = { mode: "static", value: 50 };
    parent.transform.rotation[2] = { mode: "static", value: 90 };
    composition.layers.push(child);
    const world = evaluateWorldTransform(child, composition, 0);
    expect(world.position[0]).toBeCloseTo(100);
    expect(world.position[1]).toBeCloseTo(60);
  });

  it("honors solo and layer timing", () => {
    const composition = createBlankProject().compositions[0];
    const second = structuredClone(composition.layers[0]);
    second.id = crypto.randomUUID();
    second.solo = true;
    second.inPoint = 2;
    composition.layers.push(second);
    expect(visibleLayersAtTime(composition, 1)).toHaveLength(1);
    expect(visibleLayersAtTime(composition, 3)).toEqual([second]);
  });

  it("expands nested compositions with wrapper transforms", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.name = "Nested";
    const child = nested.layers[0];
    child.id = crypto.randomUUID();
    child.transform.position[0] = { mode: "static", value: nested.width / 2 + 100 };
    child.transform.position[1] = { mode: "static", value: nested.height / 2 };
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.size = [nested.width, nested.height];
    wrapper.transform.scale[0] = { mode: "static", value: 200 };
    root.layers = [wrapper];
    project.compositions.push(nested);

    const flattened = flattenSceneLayers(root, project, 0);
    expect(flattened).toHaveLength(1);
    expect(flattened[0].layer.id).toBe(child.id);
    expect(flattened[0].selectionId).toBe(wrapper.id);
    expect(flattened[0].transform.position[0]).toBeCloseTo(root.width / 2 + 200);
  });

  it("rejects recursive precomposition cycles", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    const rootWrapper = createLayerForComposition("precomposition", root);
    rootWrapper.sourceCompositionId = nested.id;
    const nestedWrapper = createLayerForComposition("precomposition", nested);
    nestedWrapper.sourceCompositionId = root.id;
    root.layers = [rootWrapper];
    nested.layers = [nestedWrapper];
    project.compositions.push(nested);
    expect(flattenSceneLayers(root, project, 0)).toEqual([]);
  });

  it("evaluates nested compositions through the wrapper time mapping", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.layers[0].id = crypto.randomUUID();
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.timeOffset = 1;
    wrapper.timeStretch = 2;
    root.layers = [wrapper];
    project.compositions.push(nested);

    expect(flattenSceneLayers(root, project, 5)[0].localTime).toBe(3.5);
  });

  it("expands cloners into stable scene instances for the current render path", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const source = composition.layers[0];
    source.transform.position[0] = { mode: "static", value: 100 };
    source.transform.position[1] = { mode: "static", value: 200 };
    source.cloner = {
      distribution: { kind: "grid", count: [3, 1, 1], spacing: [50, 0, 0] },
      effectors: [
        {
          id: "offset",
          kind: "position",
          enabled: true,
          strength: 1,
          value: [10, 5, 0],
        },
      ],
    };

    const flattened = flattenSceneLayers(composition, project, 0);
    expect(flattened).toHaveLength(3);
    expect(flattened.map((scene) => scene.instanceId)).toEqual([
      `root/${source.id}:clone-0`,
      `root/${source.id}:clone-1`,
      `root/${source.id}:clone-2`,
    ]);
    expect(new Set(flattened.map((scene) => scene.resourceInstanceId))).toEqual(
      new Set([`root/${source.id}`]),
    );
    expect(flattened.map((scene) => scene.transform.position)).toEqual([
      [60, 205, 0],
      [110, 205, 0],
      [160, 205, 0],
    ]);
    expect(flattened.every((scene) => scene.selectionId === source.id)).toBe(true);
  });

  it("bounds recursively multiplied precomposition clones", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = createBlankProject().compositions[0];
    nested.id = crypto.randomUUID();
    nested.layers[0].cloner = {
      distribution: { kind: "grid", count: [512, 128, 1], spacing: [1, 1, 0] },
      effectors: [],
    };
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [1, 0, 0] },
      effectors: [],
    };
    root.layers = [wrapper];
    project.compositions.push(nested);

    expect(flattenSceneLayers(root, project, 0)).toHaveLength(65_536);
  });

  it("keeps adjustment evaluation local and non-spatial", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const adjustment = createLayerForComposition("adjustment", root);
    adjustment.cloner = {
      distribution: { kind: "grid", count: [4, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    root.layers = [adjustment];
    expect(flattenSceneLayers(root, project, 0)).toHaveLength(1);

    const nested = createBlankProject().compositions[0];
    nested.id = crypto.randomUUID();
    nested.layers = [createLayerForComposition("adjustment", nested), nested.layers[0]];
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    root.layers = [wrapper];
    project.compositions.push(nested);

    expect(() => flattenSceneLayers(root, project, 0)).toThrow(
      "Precomposition sources cannot contain adjustment layers",
    );
  });
});
