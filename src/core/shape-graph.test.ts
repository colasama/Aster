import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import {
  flattenShapeGraph,
  SHAPE_GRAPH_LIMITS,
  ShapeEvaluationCache,
  type ShapeGraph,
  type ShapeGroupTransform,
  validateShapeGraph,
} from "./shape-graph";
import { type BezierPath, staticValue } from "./types";

const transform = (x = 0, y = 0): ShapeGroupTransform => ({
  position: [staticValue(x), staticValue(y)],
  scale: [staticValue(100), staticValue(100)],
  rotation: staticValue(0),
  opacity: staticValue(100),
});

const path: BezierPath = {
  closed: true,
  vertices: [
    { position: [0, 0], inTangent: [0, 0], outTangent: [0, 0] },
    { position: [1, 1], inTangent: [0, 0], outTangent: [0, 0] },
  ],
};

function graph(): ShapeGraph {
  return {
    id: "graph",
    revision: 1,
    paths: [{ id: "shared", revision: 1, path: structuredClone(path) }],
    groups: [
      {
        id: "root",
        name: "Root",
        visible: true,
        transform: transform(10, 0),
        children: [{ kind: "group", id: "nested-ref", groupId: "nested" }],
      },
      {
        id: "nested",
        name: "Nested",
        visible: true,
        transform: transform(20, 5),
        children: [
          { kind: "path", id: "first", pathId: "shared", visible: true },
          { kind: "path", id: "second", pathId: "shared", visible: true },
        ],
      },
    ],
    rootGroupIds: ["root"],
  };
}

describe("shape graph", () => {
  it("reuses one path resource across grouped instances and effect masks", () => {
    const composition = createBlankProject().compositions[0];
    const layer = createLayerForComposition("shape", composition);
    layer.shapeGraph = graph();
    layer.effects.push({
      id: "masked",
      type: "test",
      name: "Masked",
      enabled: true,
      parameters: {},
      mask: {
        shape: "path",
        pathId: "shared",
        center: [0, 0],
        size: [100, 100],
        feather: 0,
        opacity: 100,
        invert: false,
      },
    });

    const evaluated = new ShapeEvaluationCache().evaluate(layer, 0);
    expect(evaluated.shapes).toHaveLength(2);
    expect(evaluated.shapes[0].path).toBe(evaluated.shapes[1].path);
    expect(evaluated.masks[0].path).toBe(evaluated.shapes[0].path);
  });

  it("composes nested transforms and rejects cycles anywhere in the graph", () => {
    expect(flattenShapeGraph(graph(), 0)[0].matrix).toEqual([1, 0, 0, 1, 30, 5]);
    const cyclic = graph();
    cyclic.groups[1].children.push({ kind: "group", id: "back", groupId: "root" });
    expect(() => validateShapeGraph(cyclic)).toThrow(/cycle/);
  });

  it("evicts least-recent graph evaluations and enforces vertex limits", () => {
    const composition = createBlankProject().compositions[0];
    const layer = createLayerForComposition("shape", composition);
    layer.shapeGraph = graph();
    const cache = new ShapeEvaluationCache({ capacity: 1 });
    cache.evaluate(layer, 0);
    cache.evaluate(layer, 1);
    expect(cache.statistics()).toMatchObject({ entries: 1, evictions: 1 });

    const oversized = graph();
    const vertex = oversized.paths[0].path.vertices[0];
    oversized.paths[0].path.vertices = Array.from(
      { length: SHAPE_GRAPH_LIMITS.verticesPerPath + 1 },
      () => structuredClone(vertex),
    );
    expect(() => validateShapeGraph(oversized)).toThrow(/at most 512/);
  });
});
