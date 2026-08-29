import type { CameraSettings } from "./types";

export const CAMERA_FOCAL_LENGTH_PRESETS_MM = [15, 20, 24, 28, 35, 50, 80, 135, 200] as const;
export const MILLIMETERS_TO_AE_PIXELS = 72 / 25.4;
export const DEFAULT_CAMERA_APERTURE_PIXELS = (50 / 5.6) * MILLIMETERS_TO_AE_PIXELS;

export interface CameraOptics {
  projection: "perspective" | "orthographic";
  zoom: number;
  filmSize: number;
  focalLength: number;
  orthographicSize: number;
  depthOfField: boolean;
  focusDistance: number;
  lockFocusToZoom: boolean;
  aperture: number;
  fStop: number;
  blurLevel: number;
  focusAreaWidth: number;
  nearBlurLevel: number;
  farBlurLevel: number;
  irisShape: CameraSettings["irisShape"];
  irisShapeCode: number;
  irisBlades: number;
  irisRotation: number;
  irisRoundness: number;
  irisAspectRatio: number;
  irisDiffractionFringe: number;
  highlightGain: number;
  highlightThreshold: number;
  highlightSaturation: number;
  renderQuality: number;
}

export type EvaluatedCameraOpticsInput = Omit<
  CameraOptics,
  "focalLength" | "fStop" | "focusDistance" | "irisBlades"
> & { focusDistance: number };

export interface CameraLensGeometry {
  zoom: number;
  angleOfViewDegrees: number;
  focalLength: number;
  filmSize: number;
}

export const DEFAULT_CAMERA_OPTICS: CameraOptics = Object.freeze({
  projection: "perspective",
  zoom: 2666.666_666_666_666_5,
  filmSize: 36,
  focalLength: 50,
  orthographicSize: 1080,
  depthOfField: false,
  focusDistance: 2666.666_666_666_666_5,
  lockFocusToZoom: true,
  aperture: DEFAULT_CAMERA_APERTURE_PIXELS,
  fStop: 5.6,
  blurLevel: 100,
  focusAreaWidth: 0,
  nearBlurLevel: 100,
  farBlurLevel: 100,
  irisShape: "fastRectangle",
  irisShapeCode: 1,
  irisBlades: 4,
  irisRotation: 0,
  irisRoundness: 0,
  irisAspectRatio: 1,
  irisDiffractionFringe: 0,
  highlightGain: 0,
  highlightThreshold: 1,
  highlightSaturation: 100,
  renderQuality: 50,
});

const MIN_POSITIVE = 1e-4;

/** AE-compatible horizontal film-back projection. */
export function lensFromFocalLength(
  focalLength: number,
  filmSize: number,
  compositionWidth: number,
): CameraLensGeometry {
  const safeFocalLength = bounded(focalLength, 0.1, 10_000, 50);
  const safeFilmSize = bounded(filmSize, 0.1, 1_000, 36);
  const safeCompositionWidth = bounded(compositionWidth, 1, 32_768, 1920);
  return {
    zoom: (safeFocalLength * safeCompositionWidth) / safeFilmSize,
    angleOfViewDegrees: radiansToDegrees(2 * Math.atan(safeFilmSize / (2 * safeFocalLength))),
    focalLength: safeFocalLength,
    filmSize: safeFilmSize,
  };
}

export function lensFromZoom(
  zoom: number,
  filmSize: number,
  compositionWidth: number,
): CameraLensGeometry {
  const safeZoom = bounded(zoom, 0.1, 1_000_000, DEFAULT_CAMERA_OPTICS.zoom);
  const safeFilmSize = bounded(filmSize, 0.1, 1_000, 36);
  const safeCompositionWidth = bounded(compositionWidth, 1, 32_768, 1920);
  return lensFromFocalLength(
    (safeZoom * safeFilmSize) / safeCompositionWidth,
    safeFilmSize,
    safeCompositionWidth,
  );
}

/** AE reports Aperture in 72-dpi pixels while focal length remains millimetres. */
export function apertureFromFStop(focalLength: number, fStop: number): number {
  return bounded(
    (bounded(focalLength, 0.1, 10_000, DEFAULT_CAMERA_OPTICS.focalLength) /
      bounded(fStop, 0.1, 1_000, DEFAULT_CAMERA_OPTICS.fStop)) *
      MILLIMETERS_TO_AE_PIXELS,
    0.001,
    10_000,
    DEFAULT_CAMERA_OPTICS.aperture,
  );
}

export function fStopFromAperture(focalLength: number, aperture: number): number {
  return bounded(
    bounded(focalLength, 0.1, 10_000, DEFAULT_CAMERA_OPTICS.focalLength) /
      (bounded(aperture, 0.001, 10_000, DEFAULT_CAMERA_OPTICS.aperture) / MILLIMETERS_TO_AE_PIXELS),
    0.1,
    1_000,
    DEFAULT_CAMERA_OPTICS.fStop,
  );
}

export function irisBladeCount(shape: CameraSettings["irisShape"]): number {
  if (shape === "circle") return 64;
  if (shape === "triangle") return 3;
  if (shape === "pentagon") return 5;
  if (shape === "hexagon") return 6;
  if (shape === "heptagon") return 7;
  if (shape === "octagon") return 8;
  if (shape === "nonagon") return 9;
  if (shape === "decagon") return 10;
  return 4;
}

export function irisShapeCode(shape: CameraSettings["irisShape"]): number {
  const shapes: readonly CameraSettings["irisShape"][] = [
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
  return Math.max(1, shapes.indexOf(shape) + 1);
}

/** Derives physical focal length and aperture from the authoritative evaluated tracks. */
export function normalizeCameraOptics(
  value: Partial<EvaluatedCameraOpticsInput>,
  compositionWidth: number,
): CameraOptics {
  const projection = value.projection === "orthographic" ? "orthographic" : "perspective";
  const filmSize = bounded(value.filmSize, 0.1, 1_000, DEFAULT_CAMERA_OPTICS.filmSize);
  const geometry = lensFromZoom(
    value.zoom ?? DEFAULT_CAMERA_OPTICS.zoom,
    filmSize,
    compositionWidth,
  );
  const aperture = bounded(value.aperture, 0.001, 10_000, DEFAULT_CAMERA_OPTICS.aperture);
  const lockFocusToZoom = value.lockFocusToZoom ?? DEFAULT_CAMERA_OPTICS.lockFocusToZoom;
  const irisShape = normalizeIrisShape(value.irisShape);
  return {
    projection,
    zoom: geometry.zoom,
    filmSize,
    focalLength: geometry.focalLength,
    orthographicSize: bounded(
      value.orthographicSize,
      1,
      10_000_000,
      DEFAULT_CAMERA_OPTICS.orthographicSize,
    ),
    depthOfField: value.depthOfField ?? DEFAULT_CAMERA_OPTICS.depthOfField,
    focusDistance: lockFocusToZoom
      ? geometry.zoom
      : bounded(value.focusDistance, 0.1, 10_000_000, geometry.zoom),
    lockFocusToZoom,
    aperture,
    fStop: fStopFromAperture(geometry.focalLength, aperture),
    blurLevel: bounded(value.blurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.blurLevel),
    focusAreaWidth: bounded(
      value.focusAreaWidth,
      0,
      10_000_000,
      DEFAULT_CAMERA_OPTICS.focusAreaWidth,
    ),
    nearBlurLevel: bounded(value.nearBlurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.nearBlurLevel),
    farBlurLevel: bounded(value.farBlurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.farBlurLevel),
    irisShape,
    irisShapeCode: irisShapeCode(irisShape),
    irisBlades: irisBladeCount(irisShape),
    irisRotation: bounded(value.irisRotation, -360, 360, DEFAULT_CAMERA_OPTICS.irisRotation),
    irisRoundness: bounded(value.irisRoundness, 0, 100, DEFAULT_CAMERA_OPTICS.irisRoundness),
    irisAspectRatio: bounded(value.irisAspectRatio, 1, 100, DEFAULT_CAMERA_OPTICS.irisAspectRatio),
    irisDiffractionFringe: bounded(
      value.irisDiffractionFringe,
      0,
      100,
      DEFAULT_CAMERA_OPTICS.irisDiffractionFringe,
    ),
    highlightGain: bounded(value.highlightGain, 0, 100, DEFAULT_CAMERA_OPTICS.highlightGain),
    highlightThreshold: bounded(
      value.highlightThreshold,
      0,
      1,
      DEFAULT_CAMERA_OPTICS.highlightThreshold,
    ),
    highlightSaturation: bounded(
      value.highlightSaturation,
      0,
      100,
      DEFAULT_CAMERA_OPTICS.highlightSaturation,
    ),
    renderQuality: bounded(value.renderQuality, 1, 100, DEFAULT_CAMERA_OPTICS.renderQuality),
  };
}

/** Signed AE 72-dpi pixel-domain circle of confusion; negative is the near field. */
export function circleOfConfusionRadius(
  optics: CameraOptics,
  cameraDepth: number,
  surfaceDepth: number,
  compositionWidth: number,
  renderWidth = compositionWidth,
): number {
  if (!optics.depthOfField || optics.projection === "orthographic") return 0;
  const distance = Math.max(Math.abs(surfaceDepth - cameraDepth), MIN_POSITIVE);
  const focusDistance = Math.max(optics.focusDistance, MIN_POSITIVE);
  const signedFocusError = distance - focusDistance;
  const defocusedDistance = Math.max(
    Math.abs(signedFocusError) - Math.max(0, optics.focusAreaWidth) * 0.5,
    0,
  );
  if (defocusedDistance === 0) return 0;
  const aperturePixels = Math.max(optics.aperture, 0);
  const focusScale = Math.max(optics.zoom, MIN_POSITIVE) / focusDistance;
  const depthScale = defocusedDistance / distance;
  const sideLevel = signedFocusError < 0 ? optics.nearBlurLevel : optics.farBlurLevel;
  const resolutionScale =
    bounded(renderWidth, 1, 32_768, compositionWidth) / bounded(compositionWidth, 1, 32_768, 1920);
  const radius =
    aperturePixels *
    0.5 *
    focusScale *
    depthScale *
    (optics.blurLevel / 100) *
    (sideLevel / 100) *
    resolutionScale;
  const boundedRadius = Math.min(radius, 256 * resolutionScale);
  return signedFocusError < 0 ? -boundedRadius : boundedRadius;
}

export function depthOfFieldSampleCount(renderQuality: number): number {
  const quality = bounded(renderQuality, 1, 100, DEFAULT_CAMERA_OPTICS.renderQuality);
  return Math.round(8 + (quality / 100) ** 2 * 56);
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
  return Math.min(maximum, Math.max(minimum, finite));
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}
