import { describe, expect, it } from "vitest";
import { evaluateLayerSourceTime } from "./layer-time";
import { activeComposition, createDemoProject } from "./project";

describe("layer source time", () => {
  it("applies source offset and playback stretch", () => {
    const layer = activeComposition(createDemoProject()).layers[0];
    layer.inPoint = 2;
    layer.timeOffset = 1;
    layer.timeStretch = 2;
    expect(evaluateLayerSourceTime(layer, 6, 20)).toBe(3);
  });

  it("evaluates animated remapping at arbitrary composition times", () => {
    const layer = activeComposition(createDemoProject()).layers[0];
    layer.timeRemap = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 5, interpolation: "linear" },
        { id: "b", time: 2, value: 1, interpolation: "linear" },
      ],
    };
    expect(evaluateLayerSourceTime(layer, 1, 20)).toBe(3);
    expect(evaluateLayerSourceTime(layer, 3, 2)).toBe(1);
  });
});
