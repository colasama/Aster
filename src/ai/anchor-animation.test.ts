import { expect, it } from "vitest";
import { evaluateLayerTransform } from "../core/animation/expressions";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { normalizeAiCommands } from "./command-normalizer";

it("authors independent mesh pivot axes through the shared command path and seeks deterministically", () => {
  const project = createBlankProject();
  const layer = createLayerForComposition("mesh", project.compositions[0]);
  project.compositions[0].layers.push(layer);
  const before = structuredClone(layer.transform);
  const { project: edited } = normalizeAiCommands(
    [
      { type: "setProperty", layerId: layer.id, path: "anchor.0", value: -120 },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: "anchor.1",
        time: 0,
        value: 40,
        interpolation: "linear",
      },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: "anchor.1",
        time: 2,
        value: 80,
        interpolation: "linear",
      },
      { type: "setProperty", layerId: layer.id, path: "anchor.2", value: 15 },
    ],
    project,
    0,
  );
  const authored = edited.compositions[0].layers.find((entry) => entry.id === layer.id);
  if (!authored) throw new Error("Missing mesh");
  expect([1.5, 0, 1, 1.5].map((time) => evaluateLayerTransform(authored, time).anchor)).toEqual([
    [-120, 70, 15],
    [-120, 40, 15],
    [-120, 60, 15],
    [-120, 70, 15],
  ]);
  expect(authored.transform.position).toEqual(before.position);
  expect(layer.transform).toEqual(before);
  expect(() =>
    normalizeAiCommands(
      [{ type: "setProperty", layerId: layer.id, path: "anchor.3", value: 10 }],
      project,
      0,
    ),
  ).toThrow();
});
