import { describe, expect, it } from "vitest";
import {
  evaluateCameraProperty,
  normalizeCameraAnimatable,
  setCameraPropertyAtTime,
} from "./camera-properties";
import { createDefaultCameraSettings } from "./camera-settings";

describe("camera option tracks", () => {
  it("evaluates, inserts, and updates camera keyframes without collapsing animation", () => {
    let camera = createDefaultCameraSettings(1920, 1080);
    camera.zoom = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 1000, interpolation: "linear" },
        { id: "end", time: 2, value: 3000, interpolation: "linear" },
      ],
    };
    expect(evaluateCameraProperty(camera, "zoom", 1)).toBe(2000);
    camera = setCameraPropertyAtTime(camera, "zoom", 1, 2400);
    expect(camera.lockFocusToZoom).toBe(false);
    expect(camera.zoom.mode).toBe("animated");
    expect(camera.zoom.mode === "animated" ? camera.zoom.keyframes : []).toHaveLength(3);
    expect(evaluateCameraProperty(camera, "zoom", 1)).toBe(2400);
    camera = setCameraPropertyAtTime(camera, "zoom", 1, 2600);
    expect(camera.zoom.mode === "animated" ? camera.zoom.keyframes : []).toHaveLength(3);
    expect(evaluateCameraProperty(camera, "zoom", 1)).toBe(2600);
  });

  it("normalizes every keyframe to the scientific camera property bounds", () => {
    expect(
      normalizeCameraAnimatable(
        {
          mode: "animated",
          keyframes: [
            { id: "low", time: 0, value: -50, interpolation: "linear" },
            { id: "high", time: 1, value: 500, interpolation: "linear" },
          ],
        },
        "irisAspectRatio",
      ),
    ).toEqual({
      mode: "animated",
      keyframes: [
        { id: "low", time: 0, value: 1, interpolation: "linear" },
        { id: "high", time: 1, value: 100, interpolation: "linear" },
      ],
    });
  });
});
