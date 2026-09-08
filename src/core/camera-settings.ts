import {
  apertureFromFStop,
  type CameraOptics,
  DEFAULT_CAMERA_OPTICS,
  fStopFromAperture,
  lensFromFocalLength,
  lensFromZoom,
  normalizeCameraOptics,
} from "./camera-optics";
import {
  CAMERA_ANIMATABLE_FIELDS,
  evaluateCameraProperty,
  normalizeCameraAnimatable,
  setCameraPropertyAtTime,
} from "./camera-properties";
import { type CameraPose, type CameraProjection, createDefaultCameraPose } from "./camera-rig";
import { isLayerActiveAtTime } from "./scene-evaluation";
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
    mode: pose.mode,
    projection: DEFAULT_CAMERA_OPTICS.projection,
    zoom: staticValue(lens.zoom),
    filmSize: staticValue(lens.filmSize),
    orthographicSize: staticValue(height),
    pointOfInterest: pose.pointOfInterest.map(staticValue) as CameraSettings["pointOfInterest"],
    orientation: pose.orientation.map(staticValue) as CameraSettings["orientation"],
    depthOfField: DEFAULT_CAMERA_OPTICS.depthOfField,
    focusDistance: staticValue(lens.zoom),
    lockFocusToZoom: DEFAULT_CAMERA_OPTICS.lockFocusToZoom,
    aperture: staticValue(DEFAULT_CAMERA_OPTICS.aperture),
    blurLevel: staticValue(DEFAULT_CAMERA_OPTICS.blurLevel),
    focusAreaWidth: staticValue(DEFAULT_CAMERA_OPTICS.focusAreaWidth),
    nearBlurLevel: staticValue(DEFAULT_CAMERA_OPTICS.nearBlurLevel),
    farBlurLevel: staticValue(DEFAULT_CAMERA_OPTICS.farBlurLevel),
    irisShape: DEFAULT_CAMERA_OPTICS.irisShape,
    irisRotation: staticValue(DEFAULT_CAMERA_OPTICS.irisRotation),
    irisRoundness: staticValue(DEFAULT_CAMERA_OPTICS.irisRoundness),
    irisAspectRatio: staticValue(DEFAULT_CAMERA_OPTICS.irisAspectRatio),
    irisDiffractionFringe: staticValue(DEFAULT_CAMERA_OPTICS.irisDiffractionFringe),
    highlightGain: staticValue(DEFAULT_CAMERA_OPTICS.highlightGain),
    highlightThreshold: staticValue(DEFAULT_CAMERA_OPTICS.highlightThreshold),
    highlightSaturation: staticValue(DEFAULT_CAMERA_OPTICS.highlightSaturation),
    renderQuality: DEFAULT_CAMERA_OPTICS.renderQuality,
  };
}

export function createDefaultCameraTransform(
  compositionWidth: number,
  compositionHeight: number,
  settings = createDefaultCameraSettings(compositionWidth, compositionHeight),
): Transform {
  const zoom = evaluateCameraProperty(settings, "zoom", 0);
  const pose = createDefaultCameraPose(compositionWidth, compositionHeight, zoom);
  return createTransform(pose.position);
}

export function normalizeCameraSettings(
  value: Partial<CameraSettings>,
  compositionWidth: number,
  compositionHeight: number,
): CameraSettings {
  const defaults = createDefaultCameraSettings(compositionWidth, compositionHeight);
  const camera = { ...defaults, ...value };
  for (const field of CAMERA_ANIMATABLE_FIELDS) {
    const fallback = field === "orthographicSize" ? compositionHeight : undefined;
    camera[field] = normalizeCameraAnimatable(value[field], field, fallback);
  }
  return {
    mode: value.mode === "oneNode" ? "oneNode" : "twoNode",
    projection: value.projection === "orthographic" ? "orthographic" : "perspective",
    zoom: camera.zoom,
    filmSize: camera.filmSize,
    orthographicSize: camera.orthographicSize,
    pointOfInterest: cloneVector(value.pointOfInterest, defaults.pointOfInterest),
    orientation: cloneVector(value.orientation, defaults.orientation),
    depthOfField: value.depthOfField ?? defaults.depthOfField,
    focusDistance: camera.focusDistance,
    lockFocusToZoom: value.lockFocusToZoom ?? defaults.lockFocusToZoom,
    aperture: camera.aperture,
    blurLevel: camera.blurLevel,
    focusAreaWidth: camera.focusAreaWidth,
    nearBlurLevel: camera.nearBlurLevel,
    farBlurLevel: camera.farBlurLevel,
    irisShape: normalizeIrisShape(value.irisShape),
    irisRotation: camera.irisRotation,
    irisRoundness: camera.irisRoundness,
    irisAspectRatio: camera.irisAspectRatio,
    irisDiffractionFringe: camera.irisDiffractionFringe,
    highlightGain: camera.highlightGain,
    highlightThreshold: camera.highlightThreshold,
    highlightSaturation: camera.highlightSaturation,
    renderQuality: bounded(value.renderQuality, 1, 100, DEFAULT_CAMERA_OPTICS.renderQuality),
  };
}

export function evaluateCameraSettings(
  settings: CameraSettings,
  transform: EvaluatedTransform,
  time: number,
  compositionWidth: number,
): EvaluatedCamera {
  const optics = normalizeCameraOptics(
    {
      projection: settings.projection,
      depthOfField: settings.depthOfField,
      lockFocusToZoom: settings.lockFocusToZoom,
      irisShape: settings.irisShape,
      renderQuality: settings.renderQuality,
      zoom: evaluateCameraProperty(settings, "zoom", time),
      filmSize: evaluateCameraProperty(settings, "filmSize", time),
      orthographicSize: evaluateCameraProperty(settings, "orthographicSize", time),
      focusDistance: evaluateCameraProperty(settings, "focusDistance", time),
      aperture: evaluateCameraProperty(settings, "aperture", time),
      blurLevel: evaluateCameraProperty(settings, "blurLevel", time),
      focusAreaWidth: evaluateCameraProperty(settings, "focusAreaWidth", time),
      nearBlurLevel: evaluateCameraProperty(settings, "nearBlurLevel", time),
      farBlurLevel: evaluateCameraProperty(settings, "farBlurLevel", time),
      irisRotation: evaluateCameraProperty(settings, "irisRotation", time),
      irisRoundness: evaluateCameraProperty(settings, "irisRoundness", time),
      irisAspectRatio: evaluateCameraProperty(settings, "irisAspectRatio", time),
      irisDiffractionFringe: evaluateCameraProperty(settings, "irisDiffractionFringe", time),
      highlightGain: evaluateCameraProperty(settings, "highlightGain", time),
      highlightThreshold: evaluateCameraProperty(settings, "highlightThreshold", time),
      highlightSaturation: evaluateCameraProperty(settings, "highlightSaturation", time),
    },
    compositionWidth,
  );
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
      orthographicSize: optics.orthographicSize,
      near: 0.1,
      far: 10_000_000,
    },
  };
}

export function setDerivedCameraPropertyAtTime(
  camera: CameraSettings,
  field: "focalLength" | "fStop",
  value: number,
  time: number,
  compositionWidth: number,
): CameraSettings {
  const zoom = evaluateCameraProperty(camera, "zoom", time);
  const filmSize = evaluateCameraProperty(camera, "filmSize", time);
  const lens = lensFromZoom(zoom, filmSize, compositionWidth);
  if (field === "focalLength") {
    const fStop = fStopFromAperture(
      lens.focalLength,
      evaluateCameraProperty(camera, "aperture", time),
    );
    const nextLens = lensFromFocalLength(value, filmSize, compositionWidth);
    const withZoom = setCameraPropertyAtTime(camera, "zoom", time, nextLens.zoom);
    return setCameraPropertyAtTime(
      withZoom,
      "aperture",
      time,
      apertureFromFStop(nextLens.focalLength, fStop),
    );
  }
  return setCameraPropertyAtTime(
    camera,
    "aperture",
    time,
    apertureFromFStop(lens.focalLength, value),
  );
}

export function createDefaultEvaluatedCamera(
  compositionWidth: number,
  compositionHeight: number,
): EvaluatedCamera {
  const settings = createDefaultCameraSettings(compositionWidth, compositionHeight);
  const zoom = evaluateCameraProperty(settings, "zoom", 0);
  const pose = createDefaultCameraPose(compositionWidth, compositionHeight, zoom);
  return evaluateCameraSettings(
    settings,
    defaultEvaluatedTransform(pose.position),
    0,
    compositionWidth,
  );
}

/** The active camera is the highest timeline camera whose span contains the current time. */
export function activeCameraLayerAtTime(composition: Composition, time: number): Layer | undefined {
  return composition.layers.find(
    (layer) => layer.kind === "camera" && isLayerActiveAtTime(layer, time),
  );
}

function defaultEvaluatedTransform(position: [number, number, number]): EvaluatedTransform {
  return { position, rotation: [0, 0, 0], scale: [100, 100, 100], anchor: [0, 0, 0], opacity: 1 };
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

function normalizeIrisShape(value: CameraSettings["irisShape"] | undefined) {
  const valid: readonly CameraSettings["irisShape"][] = [
    "fastRectangle",
    "square",
    "triangle",
    "pentagon",
    "hexagon",
    "heptagon",
    "octagon",
    "nonagon",
    "decagon",
    "circle",
  ];
  return value && valid.includes(value) ? value : DEFAULT_CAMERA_OPTICS.irisShape;
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
