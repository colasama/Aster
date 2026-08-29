import { describe, expect, it } from "vitest";
import { planCompositionCrop } from "./composition-crop";
import { applyOperations } from "./operations";
import { createBlankProject } from "./project";

describe("composition crop", () => {
  it("crops to rendered bounds and offsets full root-layer animation", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = composition?.layers[0];
    if (!composition || !layer) throw new Error("Blank project must contain a layer");
    layer.size = [100, 80];
    layer.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "x-0", time: 0, value: 200, interpolation: "linear" },
        { id: "x-1", time: 1, value: 300, interpolation: "linear" },
      ],
    };
    layer.transform.position[1] = { mode: "static", value: 150 };

    const plan = planCompositionCrop(composition, [layer.id], 0);
    expect(plan?.bounds).toEqual({ left: 200, top: 150, right: 300, bottom: 230 });
    const cropped = applyOperations(project, [...(plan?.operations ?? [])]);
    const croppedComposition = cropped.compositions[0];
    const croppedLayer = croppedComposition?.layers[0];
    expect(croppedComposition).toMatchObject({ width: 100, height: 80 });
    expect(croppedLayer?.transform.position[0]).toMatchObject({
      mode: "animated",
      keyframes: [
        { id: "x-0", value: 0 },
        { id: "x-1", value: 100 },
      ],
    });
    expect(croppedLayer?.transform.position[1]).toEqual({ mode: "static", value: 0 });
  });

  it("rejects selections without a two-dimensional visual bound", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = composition?.layers[0];
    if (!composition || !layer) throw new Error("Blank project must contain a layer");
    layer.threeDimensional = true;
    expect(planCompositionCrop(composition, [layer.id], 0)).toBeUndefined();
  });
});
