import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import { type Layer, setLayerSizeAndCenterAnchor } from "../types";
import { fitLayerToCamera } from "./camera-fit";

function scene() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.layers = [];
  const layer = createLayerForComposition("solid", composition, 0);
  layer.threeDimensional = true;
  layer.outPoint = composition.duration;
  setLayerSizeAndCenterAnchor(layer, [composition.width, composition.height]);
  composition.layers.push(layer);
  return { project, composition, layer };
}

function animate(layer: Layer, path: "position.2", from: number, to: number, end: number) {
  const index = Number(path.split(".")[1]);
  layer.transform.position[index] = {
    mode: "animated",
    keyframes: [
      { id: "a", time: 0, value: from, interpolation: "linear" },
      { id: "b", time: end, value: to, interpolation: "linear" },
    ],
  };
}

describe("camera fitting", () => {
  it("needs no scaling for a frame-sized layer under the default camera", () => {
    const { composition, layer } = scene();
    const fit = fitLayerToCamera(composition, layer, { samples: 4 });
    expect(fit.scaleMultiplier).toBeCloseTo(1, 3);
    expect(fit.alreadyCovered).toBe(true);
  });

  it("grows for margins and for layers pushed away from the camera", () => {
    const { composition, layer } = scene();
    const margin = fitLayerToCamera(composition, layer, { margin: 96, samples: 2 });
    expect(margin.scaleMultiplier).toBeCloseTo(
      Math.max(
        (composition.width + 192) / composition.width,
        (composition.height + 192) / composition.height,
      ),
      2,
    );
    animate(layer, "position.2", 0, 2000, composition.duration);
    const moving = fitLayerToCamera(composition, layer, { samples: 16 });
    expect(moving.scaleMultiplier).toBeGreaterThan(1.5);
    expect(moving.criticalTime).toBeGreaterThan(composition.duration * 0.8);
  });

  it("rejects 2D layers with a recovery hint", () => {
    const { composition, layer } = scene();
    layer.threeDimensional = false;
    expect(() => fitLayerToCamera(composition, layer)).toThrow("enable threeDimensional");
  });
});
