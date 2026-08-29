import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import type { Layer } from "../core/types";
import { keyframePreviewFromOperations } from "./TimelineKeyframe";
import {
  collectTimelinePropertyGroups,
  evaluateTimelinePropertyTrack,
  previewKeyframeTimes,
} from "./timeline-property-tracks";

describe("expanded timeline property tracks", () => {
  it("exposes editable transform channels and static effect parameters", () => {
    const testLayer = layer();
    const groups = collectTimelinePropertyGroups(testLayer);

    expect(groups[0].tracks).toHaveLength(10);
    expect(groups[0].tracks.map((track) => track.id)).toContain("opacity");
    expect(groups[1]).toMatchObject({ label: "Gaussian Blur", source: "effect" });
    expect(groups[1].tracks.map((track) => track.id)).toContain("blur:radius");
  });

  it("evaluates values against the live keyframe drag preview", () => {
    const opacity = collectTimelinePropertyGroups(layer())[0].tracks.find(
      (track) => track.id === "opacity",
    );
    if (!opacity) throw new Error("Expected opacity track");
    if (opacity.source !== "transform") throw new Error("Expected a transform track");

    expect(evaluateTimelinePropertyTrack(opacity, 1)).toBe(50);
    expect(evaluateTimelinePropertyTrack(opacity, 1, { end: 4 })).toBe(75);
    expect(
      previewKeyframeTimes(opacity.property.mode === "animated" ? opacity.property.keyframes : [], {
        end: 4,
      }).map((keyframe) => keyframe.time),
    ).toEqual([0, 4]);
  });

  it("shares every selected keyframe time during a drag preview", () => {
    expect(
      keyframePreviewFromOperations([
        { type: "moveKeyframe", layerId: "layer", path: "opacity", keyframeId: "a", time: 2 },
        {
          type: "moveEffectParameterKeyframe",
          layerId: "layer",
          effectId: "blur",
          parameter: "radius",
          keyframeId: "b",
          time: 3,
        },
      ]),
    ).toEqual({ a: 2, b: 3 });
  });

  it("exposes point-of-interest and orientation channels for camera graph editing", () => {
    const composition = createBlankProject().compositions[0];
    const camera = createLayerForComposition("camera", composition);
    const group = collectTimelinePropertyGroups(camera).find(
      (candidate) => candidate.id === "camera",
    );

    expect(group?.tracks.map((track) => track.id)).toEqual([
      "camera.pointOfInterest.0",
      "camera.pointOfInterest.1",
      "camera.pointOfInterest.2",
      "camera.orientation.0",
      "camera.orientation.1",
      "camera.orientation.2",
    ]);
  });
});

function layer(): Layer {
  const staticValue = (value: number) => ({ mode: "static" as const, value });
  return {
    id: "layer",
    name: "Layer",
    kind: "shape",
    visible: true,
    solo: false,
    locked: false,
    threeDimensional: false,
    inPoint: 0,
    outPoint: 10,
    blendMode: "normal",
    color: [1, 1, 1, 1],
    size: [1920, 1080],
    effects: [
      {
        id: "blur",
        type: "gaussian-blur",
        name: "Gaussian Blur",
        enabled: true,
        parameters: { radius: 18, repeatEdge: 0 },
      },
    ],
    transform: {
      position: [staticValue(0), staticValue(0), staticValue(0)],
      rotation: [staticValue(0), staticValue(0), staticValue(0)],
      scale: [staticValue(100), staticValue(100), staticValue(100)],
      anchor: [staticValue(0), staticValue(0), staticValue(0)],
      opacity: {
        mode: "animated",
        keyframes: [
          { id: "start", time: 0, value: 100, interpolation: "linear" },
          { id: "end", time: 2, value: 0, interpolation: "linear" },
        ],
      },
    },
  };
}
