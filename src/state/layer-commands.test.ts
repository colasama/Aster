import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { activeComposition, createBlankProject } from "../core/project/project";
import { duplicateSelectedLayers, removeSelectedLayersOperations } from "./layer-commands";

function project() {
  const value = createBlankProject();
  const composition = activeComposition(value);
  const top = createLayerForComposition("shape", composition);
  top.transform.opacity = {
    mode: "animated",
    keyframes: [{ id: "fade", time: 0, value: 0, interpolation: "linear" }],
  };
  composition.layers = [top, ...composition.layers];
  return { value, top, background: composition.layers[1] };
}

describe("layer selection commands", () => {
  it("deletes every selected layer, including the last one in a composition", () => {
    const { value, top, background } = project();
    expect(removeSelectedLayersOperations(value, [top.id, background.id])).toEqual([
      { type: "removeLayer", layerId: top.id },
      { type: "removeLayer", layerId: background.id },
    ]);
  });

  it("refuses empty or locked selections", () => {
    const { value, top } = project();
    expect(removeSelectedLayersOperations(value, [])).toBeUndefined();
    top.locked = true;
    expect(removeSelectedLayersOperations(value, [top.id])).toBeUndefined();
  });

  it("duplicates with fresh layer and keyframe identities", () => {
    const { value, top } = project();
    const [copy] = duplicateSelectedLayers(value, [top.id], (name) => `${name} copy`);
    expect(copy.id).not.toBe(top.id);
    expect(copy.name).toBe(`${top.name} copy`);
    const opacity = copy.transform.opacity;
    expect(opacity.mode === "animated" && opacity.keyframes[0].id).not.toBe("fade");
  });
});
