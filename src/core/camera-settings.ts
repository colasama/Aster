import {
  type CameraOptics,
  DEFAULT_CAMERA_OPTICS,
  lensFromFocalLength,
  normalizeCameraOptics,
} from "./camera-optics";
import { type CameraPose, type CameraProjection, createDefaultCameraPose } from "./camera-rig";
import { evaluateAnimatable } from "./timeline";
import type { CameraSettings, Composition, EvaluatedTransform, Layer, Transform } from "./types";
import { createTransform, staticValue } from "./types";

export interface EvaluatedCamera {
  pose: CameraPose;
  projection: CameraProjection;
  optics: CameraOptics;
}

export function createDefaultCameraSettings(
  compositionWidth: number,
  compositionHeight: number,
): CameraSettings {
  const width = positive(compositionWidth, 1920);
  const height = positive(compositionHeight, 1080);
  const lens = lensFromFocalLength(DEFAULT_CAMERA_OPTICS.focalLength, 36, width);
  const pose = createDefaultCameraPose(width, height, lens.zoom);
  return {
    ...DEFAULT_CAMERA_OPTICS,
    zoom: lens.zoom,
    focalLength: lens.focalLength,
    filmSize: lens.filmSize,
    focusDistance: lens.zoom,
    mode: pose.mode,
    orthographicSize: height,
    pointOfInterest: pose.pointOfInterest.map(staticValue) as CameraSettings["pointOfInterest"],
    orientation: pose.orientation.map(staticValue) as CameraSettings["orientation"],
  };
}

export function createDefaultCameraTransform(
  compositionWidth: number,
  compositionHeight: number,
  settings = createDefaultCameraSettings(compositionWidth, compositionHeight),
): Transform {
  const pose = createDefaultCameraPose(compositionWidth, compositionHeight, settings.zoom);
  return createTransform(pose.position);
}

export function normalizeCameraSettings(
  value: Partial<CameraSettings>,
  compositionWidth: number,
  compositionHeight: number,
): CameraSettings {
  const defaults = createDefaultCameraSettings(compositionWidth, compositionHeight);
  const optics = normalizeCameraOptics(value, compositionWidth);
  return {
    ...optics,
    mode: value.mode === "oneNode" ? "oneNode" : "twoNode",
    orthographicSize: bounded(value.orthographicSize, 1, 10_000_000, compositionHeight),
    pointOfInterest: cloneVector(value.pointOfInterest, defaults.pointOfInterest),
    orientation: cloneVector(value.orientation, defaults.orientation),
  };
}

export function evaluateCameraSettings(
  settings: CameraSettings,
  transform: EvaluatedTransform,
  time: number,
  compositionWidth: number,
): EvaluatedCamera {
  const optics = normalizeCameraOptics(settings, compositionWidth);
  const pose: CameraPose = {
    mode: settings.mode,
    position: [...transform.position],
    pointOfInterest: evaluateVector(settings.pointOfInterest, time),
    orientation: evaluateVector(settings.orientation, time),
    rotation: [...transform.rotation],
  };
  return {
    pose,
    optics,
    projection: {
      kind: settings.projection,
      zoom: optics.zoom,
      orthographicSize: settings.orthographicSize,
      near: 0.1,
      far: 10_000_000,
    },
  };
}

export function createDefaultEvaluatedCamera(
  compositionWidth: number,
  compositionHeight: number,
): EvaluatedCamera {
  const settings = createDefaultCameraSettings(compositionWidth, compositionHeight);
  const pose = createDefaultCameraPose(compositionWidth, compositionHeight, settings.zoom);
  return {
    pose,
    optics: normalizeCameraOptics(settings, compositionWidth),
    projection: {
      kind: settings.projection,
      zoom: settings.zoom,
      orthographicSize: settings.orthographicSize,
      near: 0.1,
      far: 10_000_000,
    },
  };
}

/** AE chooses the highest timeline camera whose span contains the current time. */
export function activeCameraLayerAtTime(composition: Composition, time: number): Layer | undefined {
  return composition.layers.find(
    (layer) => layer.kind === "camera" && time >= layer.inPoint && time <= layer.outPoint,
  );
}

function evaluateVector(
  vector: CameraSettings["pointOfInterest"],
  time: number,
): [number, number, number] {
  return vector.map((property) => evaluateAnimatable(property, time)) as [number, number, number];
}

function cloneVector(
  value: CameraSettings["pointOfInterest"] | undefined,
  fallback: CameraSettings["pointOfInterest"],
): CameraSettings["pointOfInterest"] {
  if (!Array.isArray(value) || value.length !== 3) return structuredClone(fallback);
  return structuredClone(value);
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, finite));
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
