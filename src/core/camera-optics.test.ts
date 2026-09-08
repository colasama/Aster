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
  it("roundtrips film size, focal length, zoom, and angle of view", () => {
    const lens = lensFromFocalLength(50, 36, 1920);
    expect(lens.zoom).toBeCloseTo(2666.666_667);
    expect(lens.angleOfViewDegrees).toBeCloseTo(39.597_753);
    expect(lensFromZoom(lens.zoom, 36, 1920).focalLength).toBeCloseTo(50);
  });

  it("keeps pixel aperture and f-stop reciprocal and lock-focus tied to pixel Zoom", () => {
    const aperture = apertureFromFStop(80, 2);
    expect(aperture).toBeCloseTo((40 * 72) / 25.4);
    expect(fStopFromAperture(80, aperture)).toBe(2);
    const optics = normalizeCameraOptics(
      {
        zoom: lensFromFocalLength(80, 36, 1920).zoom,
        filmSize: 36,
        aperture,
        lockFocusToZoom: true,
      },
      1920,
    );
    expect(optics.zoom).toBeCloseTo(4266.666_667);
    expect(optics.focusDistance).toBe(optics.zoom);
    expect(optics.aperture).toBeCloseTo(aperture);
  });

  it("creates signed near/far blur, a sharp focus area, and resolution-scaled radii", () => {
    const optics = normalizeCameraOptics(
      {
        ...DEFAULT_CAMERA_OPTICS,
        depthOfField: true,
        lockFocusToZoom: false,
        focusDistance: 1000,
        focusAreaWidth: 100,
        aperture: DEFAULT_CAMERA_OPTICS.zoom / 50,
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

  it("keeps the locked default lens non-degenerate in virtual-camera pixel units", () => {
    const optics = normalizeCameraOptics(
      { ...DEFAULT_CAMERA_OPTICS, depthOfField: true, lockFocusToZoom: true },
      1920,
    );
    expect(optics.focusDistance).toBe(optics.zoom);
    expect(optics.focalLength).toBeCloseTo(50);
    expect(optics.fStop).toBeCloseTo(5.6);
    expect(optics.aperture).toBeCloseTo(25.31, 2);
    const radius = circleOfConfusionRadius(optics, 0, optics.zoom * 2, 1920);
    expect(radius).toBeGreaterThan(0);
    expect(circleOfConfusionRadius(optics, 0, optics.zoom * 2, 1920, 960)).toBeCloseTo(
      radius * 0.5,
    );
  });
});
