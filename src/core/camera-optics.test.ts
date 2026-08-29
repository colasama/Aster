import { describe, expect, it } from "vitest";
import {
  apertureFromFStop,
  circleOfConfusionRadius,
  DEFAULT_CAMERA_OPTICS,
  depthOfFieldSampleCount,
  fStopFromAperture,
  lensFromFocalLength,
  lensFromZoom,
  normalizeCameraOptics,
} from "./camera-optics";

describe("camera optics", () => {
  it("roundtrips AE film size, focal length, zoom, and angle of view", () => {
    const lens = lensFromFocalLength(50, 36, 1920);
    expect(lens.zoom).toBeCloseTo(2666.666_667);
    expect(lens.angleOfViewDegrees).toBeCloseTo(39.597_753);
    expect(lensFromZoom(lens.zoom, 36, 1920).focalLength).toBeCloseTo(50);
  });

  it("keeps aperture and f-stop reciprocal and lock-focus tied to zoom", () => {
    const aperture = apertureFromFStop(80, 2);
    expect(aperture).toBe(40);
    expect(fStopFromAperture(80, aperture)).toBe(2);
    const optics = normalizeCameraOptics(
      { focalLength: 80, filmSize: 36, fStop: 2, lockFocusToZoom: true },
      1920,
    );
    expect(optics.zoom).toBeCloseTo(4266.666_667);
    expect(optics.focusDistance).toBe(optics.zoom);
    expect(optics.aperture).toBe(40);
  });

  it("creates signed near/far blur, a sharp focus area, and resolution-scaled radii", () => {
    const optics = normalizeCameraOptics(
      {
        ...DEFAULT_CAMERA_OPTICS,
        depthOfField: true,
        lockFocusToZoom: false,
        focusDistance: 1000,
        focusAreaWidth: 100,
        aperture: 1,
        nearBlurLevel: 25,
        farBlurLevel: 100,
      },
      1920,
    );
    expect(circleOfConfusionRadius(optics, 0, 1000, 1920)).toBe(0);
    expect(circleOfConfusionRadius(optics, 0, 1049, 1920)).toBe(0);
    const near = circleOfConfusionRadius(optics, 0, 400, 1920);
    const far = circleOfConfusionRadius(optics, 0, 2000, 1920);
    expect(near).toBeLessThan(0);
    expect(far).toBeGreaterThan(0);
    expect(Math.abs(far)).toBeGreaterThan(Math.abs(near));
    expect(circleOfConfusionRadius(optics, 0, 2000, 1920, 960)).toBeCloseTo(far * 0.5);
  });

  it("disables optical blur for orthographic cameras and bounds quality", () => {
    const optics = normalizeCameraOptics(
      { ...DEFAULT_CAMERA_OPTICS, projection: "orthographic", depthOfField: true },
      1920,
    );
    expect(circleOfConfusionRadius(optics, 0, 5000, 1920)).toBe(0);
    expect(depthOfFieldSampleCount(1)).toBeGreaterThanOrEqual(8);
    expect(depthOfFieldSampleCount(100)).toBe(64);
    expect(depthOfFieldSampleCount(Infinity)).toBe(depthOfFieldSampleCount(50));
  });
});
