import { describe, expect, it } from "vitest";
import {
  type CameraProjection,
  cameraRayFromScreen,
  createDefaultCameraPose,
  dollyCamera,
  evaluateCameraBasis,
  orbitCamera,
  panCamera,
  projectCameraPoint,
  unprojectCameraPoint,
  worldToCamera,
} from "./camera-rig";

const perspective: CameraProjection = {
  kind: "perspective",
  zoom: 2666.666_666_666_666_5,
  orthographicSize: 1080,
  near: 0.1,
  far: 100_000,
};

describe("camera rig", () => {
  it("keeps the composition plane pixel-identical at the Zoom distance", () => {
    const pose = createDefaultCameraPose(1920, 1080, perspective.zoom);
    expect(projectCameraPoint([0, 0, 0], pose, perspective, [1920, 1080]).screen).toEqual([0, 0]);
    expect(projectCameraPoint([960, 540, 0], pose, perspective, [1920, 1080])).toMatchObject({
      screen: [960, 540],
      cameraDepth: perspective.zoom,
      visible: true,
    });
    expect(projectCameraPoint([1920, 1080, 0], pose, perspective, [1920, 1080]).screen).toEqual([
      1920, 1080,
    ]);
  });

  it("roundtrips arbitrary world points through perspective and orthographic projection", () => {
    const pose = {
      ...createDefaultCameraPose(1920, 1080, perspective.zoom),
      position: [120, -40, -2400] as [number, number, number],
      pointOfInterest: [900, 500, 200] as [number, number, number],
      rotation: [4, -8, 3] as [number, number, number],
    };
    for (const projection of [
      perspective,
      { ...perspective, kind: "orthographic" as const, orthographicSize: 720 },
    ]) {
      const source: [number, number, number] = [800, 400, 120];
      const projected = projectCameraPoint(source, pose, projection, [1920, 1080]);
      const restored = unprojectCameraPoint(
        projected.screen,
        projected.cameraDepth,
        pose,
        projection,
        [1920, 1080],
      );
      expect(restored[0]).toBeCloseTo(source[0], 8);
      expect(restored[1]).toBeCloseTo(source[1], 8);
      expect(restored[2]).toBeCloseTo(source[2], 8);
    }
  });

  it("keeps two-node cameras pointed at the POI and survives coincident and vertical poses", () => {
    const pose = createDefaultCameraPose(1920, 1080, perspective.zoom);
    expect(worldToCamera(pose.pointOfInterest, pose)).toEqual([0, 0, perspective.zoom]);
    const vertical = {
      ...pose,
      position: [0, -10, 0] as [number, number, number],
      pointOfInterest: [0, 0, 0] as [number, number, number],
    };
    const basis = evaluateCameraBasis(vertical);
    expect(Math.hypot(...basis.right)).toBeCloseTo(1);
    expect(Math.hypot(...basis.down)).toBeCloseTo(1);
    expect(Math.hypot(...basis.forward)).toBeCloseTo(1);
    const coincident = evaluateCameraBasis({ ...pose, position: pose.pointOfInterest });
    expect(coincident.forward).toEqual([0, 0, 1]);
  });

  it("creates center and off-axis screen rays that reproject to their source pixels", () => {
    const pose = createDefaultCameraPose(1920, 1080, perspective.zoom);
    expect(cameraRayFromScreen([960, 540], pose, perspective, [1920, 1080]).direction).toEqual([
      0, 0, 1,
    ]);
    const ray = cameraRayFromScreen([1500, 300], pose, perspective, [1920, 1080]);
    const point: [number, number, number] = [
      ray.origin[0] + ray.direction[0] * 4000,
      ray.origin[1] + ray.direction[1] * 4000,
      ray.origin[2] + ray.direction[2] * 4000,
    ];
    const screen = projectCameraPoint(point, pose, perspective, [1920, 1080]).screen;
    expect(screen[0]).toBeCloseTo(1500, 8);
    expect(screen[1]).toBeCloseTo(300, 8);
  });

  it("orbits, pans, and dollies without breaking two-node invariants", () => {
    const pose = createDefaultCameraPose(1920, 1080, perspective.zoom);
    const orbit = orbitCamera(pose, 30, -15);
    expect(Math.hypot(...worldToCamera(orbit.pointOfInterest, orbit))).toBeCloseTo(
      perspective.zoom,
    );
    expect(worldToCamera(orbit.pointOfInterest, orbit)[0]).toBeCloseTo(0, 8);
    expect(worldToCamera(orbit.pointOfInterest, orbit)[1]).toBeCloseTo(0, 8);
    const pan = panCamera(orbit, [100, -50], perspective.zoom, perspective, 1080);
    expect(worldToCamera(pan.pointOfInterest, pan)[2]).toBeCloseTo(perspective.zoom);
    const dolly = dollyCamera(pan, 100);
    expect(worldToCamera(dolly.pointOfInterest, dolly)[2]).toBeCloseTo(perspective.zoom - 100);
    const clamped = dollyCamera(pan, perspective.zoom * 2);
    expect(worldToCamera(clamped.pointOfInterest, clamped)[2]).toBeGreaterThan(0);
  });
});
