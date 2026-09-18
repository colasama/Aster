import { expect, it } from "vitest";
import { applyOperations } from "../core/editing/operations";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { addLayerStyleOperations, canAddLayerStyle } from "./layer-style-actions";

it("creates independent styles for every selected visual layer in one operation group", () => {
  const project = createBlankProject(true);
  const composition = project.compositions[0];
  const layers = [
    createLayerForComposition("text", composition),
    createLayerForComposition("shape", composition),
  ];
  composition.layers = layers;
  const operations = addLayerStyleOperations(layers, "color-overlay");
  const result = applyOperations(project, operations);
  const effects = result.compositions[0].layers.map(
    (layer) => layer.effects[layer.effects.length - 1],
  );
  expect(effects[0]?.id).not.toBe(effects[1]?.id);
  expect(effects.map((effect) => effect?.parameters.opacity)).toEqual([100, 100]);
  expect(layers.map((layer) => layer.effects.length)).toEqual([0, 0]);
  layers[1].locked = true;
  expect(addLayerStyleOperations(layers, "outer-glow")).toEqual([]);
  expect(canAddLayerStyle([])).toBe(false);
  for (const kind of ["audio", "camera", "light", "null", "adjustment"] as const) {
    expect(canAddLayerStyle([createLayerForComposition(kind, composition)])).toBe(false);
  }
});
