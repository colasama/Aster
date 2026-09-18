import { assert, expect, it } from "vitest";
import { normalizeAiCommands } from "../../ai/command-normalizer";
import { collectTimelinePropertyGroups } from "../../components/timeline/timeline-property-tracks";
import { buildSceneGeometry } from "../../renderer/geometry/geometry";
import { createDefaultBezierPath } from "../../renderer/geometry/vector-path";
import { getProperty } from "../editing/operations";
import { createBlankProject } from "../project/project";
import { serializeProject, validateProjectDocument } from "../project/project-file";
import { flattenSceneLayers } from "../scene/scene-evaluation";
import { staticValue } from "../types";
import { evaluateShapePath } from "./path-morph";

function fixture() {
  const project = createBlankProject(true);
  const composition = project.compositions[0];
  const layer = composition.layers[0];
  if (!layer.shape) throw new Error("Missing shape");
  const path = createDefaultBezierPath();
  const target = structuredClone(path);
  target.vertices[0].outTangent = [0.4, 0.5];
  target.vertices[1].inTangent = [-0.4, -0.5];
  layer.shape = {
    ...layer.shape,
    kind: "bezier",
    strokeWidth: 3,
    path,
    morph: { target, progress: staticValue(0) },
  };
  return { project, composition, layer, shape: layer.shape };
}
it("roundtrips morphs and edits their progress through the actual MCP command normalizer", () => {
  const { project, layer } = fixture();
  const normalized = normalizeAiCommands(
    [
      { type: "setShapeSettings", layerId: layer.id, shape: layer.shape },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: "shape.morphProgress",
        time: 0,
        value: 0,
        interpolation: "linear",
      },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: "shape.morphProgress",
        time: 2,
        value: 100,
        interpolation: "linear",
      },
    ],
    project,
    0,
  );
  const roundtrip = validateProjectDocument(JSON.parse(serializeProject(normalized.project)));
  const restored = roundtrip.compositions[0].layers[0];
  expect(getProperty(restored, "shape.morphProgress").mode).toBe("animated");
  expect(
    collectTimelinePropertyGroups(restored).find((group) => group.id === "path-morph")?.tracks,
  ).toHaveLength(1);
  const shape = restored.shape;
  assert(shape?.morph);
  const midpoint = evaluateShapePath(shape, 1);
  assert(midpoint);
  expect(midpoint.vertices[0].outTangent).toEqual([0.34, 0]);
  expect(evaluateShapePath(shape, 2)).toBe(shape.morph.target);
  expect(evaluateShapePath(shape, -1)).toBe(shape.path);
  expect(evaluateShapePath(shape, 1)).toEqual(midpoint);
});
it("changes actual tessellated geometry and supports random-time evaluation without mutation", () => {
  const { project, composition, shape } = fixture();
  assert(shape.morph);
  shape.morph.progress = {
    mode: "animated",
    keyframes: [
      { id: "a", time: 0, value: 0, interpolation: "linear" },
      { id: "b", time: 2, value: 100, interpolation: "linear" },
    ],
  };
  const source = JSON.stringify(shape.path);
  const geometry = (time: number) =>
    buildSceneGeometry(composition, flattenSceneLayers(composition, project, time)).data;
  const first = geometry(0),
    middle = geometry(1);
  expect(geometry(2)).not.toEqual(first);
  expect(middle).not.toEqual(first);
  expect(geometry(1)).toEqual(middle);
  expect(JSON.stringify(shape.path)).toBe(source);
  expect(evaluateShapePath(shape, 1, "100")).toBe(shape.morph.target);
});
it("rejects mismatched topology and non-finite control points at project boundaries", () => {
  const { project, shape } = fixture();
  assert(shape.morph);
  shape.morph.target.closed = true;
  expect(() => validateProjectDocument(project)).toThrow("topology");
  shape.morph.target.closed = false;
  shape.morph.target.vertices[0].position[0] = Number.NaN;
  expect(() => validateProjectDocument(project)).toThrow();
});
