import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import { applyOperations } from "./operations";
import { propertyValueOperationAtTime } from "./property-edit-operation";

describe("time-addressed property value operations", () => {
  it("preserves existing keyframe identity and interpolation metadata", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const layer = createLayerForComposition("solid", composition);
    layer.transform.rotation[2] = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 0, interpolation: "linear" },
        {
          id: "current",
          time: 1,
          value: 45,
          interpolation: "bezier",
          easing: [0.2, 0.1, 0.8, 0.9],
          spatialIn: -5,
          spatialOut: 8,
        },
      ],
    };
    composition.layers = [layer];

    const operation = propertyValueOperationAtTime(layer, "rotation.2", 60, 1);
    expect(operation).toMatchObject({
      type: "addKeyframe",
      keyframe: {
        id: "current",
        time: 1,
        value: 60,
        interpolation: "bezier",
        easing: [0.2, 0.1, 0.8, 0.9],
        spatialIn: -5,
        spatialOut: 8,
      },
    });
    const edited = applyOperations(project, [operation]).compositions[0].layers[0].transform
      .rotation[2];
    expect(edited.mode === "animated" ? edited.keyframes : []).toHaveLength(2);
  });

  it("keeps static values static and inserts new animation keys at a bounded edit time", () => {
    const project = createBlankProject(true);
    const composition = project.compositions[0];
    const layer = createLayerForComposition("camera", composition);
    if (!layer.camera) throw new Error("Expected camera settings");
    expect(propertyValueOperationAtTime(layer, "position.0", 120, 2)).toMatchObject({
      type: "setProperty",
      value: 120,
    });

    layer.camera.orientation[1] = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 0, interpolation: "linear" },
        { id: "end", time: 2, value: 90, interpolation: "linear" },
      ],
    };
    expect(
      propertyValueOperationAtTime(layer, "camera.orientation.1", 30, -1, "inserted"),
    ).toMatchObject({
      type: "addKeyframe",
      keyframe: { id: "start", time: 0, value: 30, interpolation: "linear" },
    });
    expect(
      propertyValueOperationAtTime(layer, "camera.orientation.1", 50, 1, "inserted"),
    ).toMatchObject({
      type: "addKeyframe",
      keyframe: { id: "inserted", time: 1, value: 50, interpolation: "linear" },
    });
  });
});
