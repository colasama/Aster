import { describe, expect, it } from "vitest";
import { evaluateTransform } from "../animation/timeline";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import { staticValue } from "../types";
import { evaluateCameraProperty } from "./camera-properties";
import { projectCameraPoint } from "./camera-rig";
import {
  activeCameraLayerAtTime,
  createDefaultCameraSettings,
  createDefaultCameraTransform,
  evaluateCameraSettings,
  normalizeCameraSettings,
  setDerivedCameraPropertyAtTime,
} from "./camera-settings";

describe("camera settings", () => {
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

    expect(camera.optics.focalLength).toBeCloseTo(50);
    expect(evaluateCameraProperty(settings, "zoom", 0)).toBeCloseTo((1920 * 50) / 36);
    expect(transform.position).toEqual([960, 540, -evaluateCameraProperty(settings, "zoom", 0)]);
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

  it("selects only the incoming camera at a shared half-open cut", () => {
    const composition = createBlankProject().compositions[0];
    const incoming = createLayerForComposition("camera", composition);
    const outgoing = createLayerForComposition("camera", composition);
    outgoing.inPoint = 0;
    outgoing.outPoint = 1;
    incoming.inPoint = 1;
    composition.layers = [incoming, outgoing];
    expect(activeCameraLayerAtTime(composition, 1)).toBe(incoming);
  });

  it("normalizes coupled lens and depth-of-field controls deterministically", () => {
    const normalized = normalizeCameraSettings(
      {
        ...createDefaultCameraSettings(1920, 1080),
        zoom: staticValue(960),
        filmSize: staticValue(48),
        aperture: staticValue((24 * 72) / 25.4),
        lockFocusToZoom: true,
        focusDistance: staticValue(42),
        renderQuality: 200,
      },
      1920,
      1080,
    );

    const evaluated = evaluateCameraSettings(
      normalized,
      evaluateTransform(createDefaultCameraTransform(1920, 1080, normalized), 0),
      0,
      1920,
    );
    expect(evaluated.optics.focalLength).toBeCloseTo(24);
    expect(evaluated.optics.fStop).toBeCloseTo(1);
    expect(evaluated.optics.focusDistance).toBe(960);
    expect(normalized.renderQuality).toBe(100);
  });

  it("derives focal length and aperture at time and inversely edits authoritative tracks", () => {
    let settings = createDefaultCameraSettings(1920, 1080);
    settings.zoom = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 1920, interpolation: "linear" },
        { id: "end", time: 2, value: 3840, interpolation: "linear" },
      ],
    };
    settings.filmSize = staticValue(48);
    settings.aperture = staticValue(((72 / 4) * 72) / 25.4);
    const transform = evaluateTransform(createDefaultCameraTransform(1920, 1080, settings), 1);
    expect(evaluateCameraSettings(settings, transform, 1, 1920).optics.focalLength).toBeCloseTo(72);
    expect(evaluateCameraSettings(settings, transform, 1, 1920).optics.aperture).toBeCloseTo(
      ((72 / 4) * 72) / 25.4,
    );

    settings = setDerivedCameraPropertyAtTime(settings, "focalLength", 50, 1, 1920);
    expect(evaluateCameraSettings(settings, transform, 1, 1920).optics.focalLength).toBeCloseTo(50);
    expect(settings.zoom.mode).toBe("animated");
    settings = setDerivedCameraPropertyAtTime(settings, "fStop", 2, 1, 1920);
    expect(evaluateCameraSettings(settings, transform, 1, 1920).optics.fStop).toBeCloseTo(2);
    expect(settings.aperture.mode).toBe("static");
  });

  it("requires the camera Video switch without changing precedence for solo", () => {
    const composition = createBlankProject().compositions[0];
    const top = createLayerForComposition("camera", composition);
    const lower = createLayerForComposition("camera", composition);
    top.visible = false;
    top.solo = true;
    lower.solo = false;
    composition.layers = [top, lower];
    expect(activeCameraLayerAtTime(composition, 1)).toBe(lower);
    top.visible = true;
    expect(activeCameraLayerAtTime(composition, 1)).toBe(top);
    expect(activeCameraLayerAtTime(composition, 1)?.solo).toBe(true);
  });
});
