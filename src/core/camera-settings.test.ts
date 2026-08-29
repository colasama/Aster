import { describe, expect, it } from "vitest";
import { projectCameraPoint } from "./camera-rig";
import {
  activeCameraLayerAtTime,
  createDefaultCameraSettings,
  createDefaultCameraTransform,
  evaluateCameraSettings,
  normalizeCameraSettings,
} from "./camera-settings";
import { createLayerForComposition } from "./layer-factory";
import { createBlankProject } from "./project";
import { evaluateTransform } from "./timeline";

describe("AE-compatible camera settings", () => {
  it("places the composition plane exactly one Zoom from the default 50 mm camera", () => {
    const settings = createDefaultCameraSettings(1920, 1080);
    const transform = evaluateTransform(createDefaultCameraTransform(1920, 1080), 0);
    const camera = evaluateCameraSettings(settings, transform, 0, 1920);
    const projected = projectCameraPoint(
      [480, 270, 0],
      camera.pose,
      camera.projection,
      [1920, 1080],
    );

    expect(settings.focalLength).toBeCloseTo(50);
    expect(settings.zoom).toBeCloseTo((1920 * 50) / 36);
    expect(transform.position).toEqual([960, 540, -settings.zoom]);
    expect(projected.screen).toEqual([480, 270]);
  });

  it("selects the highest camera whose timeline span contains the evaluated time", () => {
    const composition = createBlankProject().compositions[0];
    const first = createLayerForComposition("camera", composition);
    const second = createLayerForComposition("camera", composition);
    first.inPoint = 1;
    second.outPoint = 2;
    composition.layers = [first, second];

    expect(activeCameraLayerAtTime(composition, 0)).toBe(second);
    expect(activeCameraLayerAtTime(composition, 1.5)).toBe(first);
    expect(activeCameraLayerAtTime(composition, 3)).toBe(first);
  });

  it("normalizes coupled lens and depth-of-field controls deterministically", () => {
    const normalized = normalizeCameraSettings(
      {
        ...createDefaultCameraSettings(1920, 1080),
        zoom: 960,
        filmSize: 48,
        aperture: 24,
        lockFocusToZoom: true,
        focusDistance: 42,
        renderQuality: 200,
      },
      1920,
      1080,
    );

    expect(normalized.focalLength).toBeCloseTo(24);
    expect(normalized.fStop).toBeCloseTo(1);
    expect(normalized.focusDistance).toBe(960);
    expect(normalized.renderQuality).toBe(100);
  });
});
