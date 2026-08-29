export const CAMERA_FOCAL_LENGTH_PRESETS_MM = [15, 20, 24, 28, 35, 50, 80, 135, 200] as const;

export interface CameraOptics {
  projection: "perspective" | "orthographic";
  zoom: number;
  filmSize: number;
  focalLength: number;
  depthOfField: boolean;
  focusDistance: number;
  lockFocusToZoom: boolean;
  aperture: number;
  fStop: number;
  blurLevel: number;
  focusAreaWidth: number;
  nearBlurLevel: number;
  farBlurLevel: number;
  renderQuality: number;
}

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
  depthOfField: false,
  focusDistance: 2666.666_666_666_666_5,
  lockFocusToZoom: true,
  aperture: 17.857_142_857_142_858,
  fStop: 2.8,
  blurLevel: 100,
  focusAreaWidth: 0,
  nearBlurLevel: 100,
  farBlurLevel: 100,
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

/** Inverse of lensFromFocalLength; useful when the AE Zoom property is animated directly. */
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

export function apertureFromFStop(focalLength: number, fStop: number): number {
  return bounded(
    bounded(focalLength, 0.1, 10_000, 50) / bounded(fStop, 0.1, 1_000, 2.8),
    0.001,
    10_000,
    DEFAULT_CAMERA_OPTICS.aperture,
  );
}

export function fStopFromAperture(focalLength: number, aperture: number): number {
  return bounded(
    bounded(focalLength, 0.1, 10_000, 50) /
      bounded(aperture, 0.001, 10_000, DEFAULT_CAMERA_OPTICS.aperture),
    0.1,
    1_000,
    DEFAULT_CAMERA_OPTICS.fStop,
  );
}

export function normalizeCameraOptics(
  value: Partial<CameraOptics>,
  compositionWidth: number,
): CameraOptics {
  const projection = value.projection === "orthographic" ? "orthographic" : "perspective";
  const filmSize = bounded(value.filmSize, 0.1, 1_000, DEFAULT_CAMERA_OPTICS.filmSize);
  const geometry =
    value.zoom !== undefined
      ? lensFromZoom(value.zoom, filmSize, compositionWidth)
      : lensFromFocalLength(
          value.focalLength ?? DEFAULT_CAMERA_OPTICS.focalLength,
          filmSize,
          compositionWidth,
        );
  const fStop = bounded(value.fStop, 0.1, 1_000, DEFAULT_CAMERA_OPTICS.fStop);
  const aperture =
    value.aperture === undefined
      ? apertureFromFStop(geometry.focalLength, fStop)
      : bounded(value.aperture, 0.001, 10_000, DEFAULT_CAMERA_OPTICS.aperture);
  const lockFocusToZoom = value.lockFocusToZoom ?? DEFAULT_CAMERA_OPTICS.lockFocusToZoom;
  return {
    projection,
    zoom: geometry.zoom,
    filmSize,
    focalLength: geometry.focalLength,
    depthOfField: value.depthOfField ?? DEFAULT_CAMERA_OPTICS.depthOfField,
    focusDistance: lockFocusToZoom
      ? geometry.zoom
      : bounded(value.focusDistance, 0.1, 10_000_000, geometry.zoom),
    lockFocusToZoom,
    aperture,
    fStop: value.aperture === undefined ? fStop : fStopFromAperture(geometry.focalLength, aperture),
    blurLevel: bounded(value.blurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.blurLevel),
    focusAreaWidth: bounded(
      value.focusAreaWidth,
      0,
      10_000_000,
      DEFAULT_CAMERA_OPTICS.focusAreaWidth,
    ),
    nearBlurLevel: bounded(value.nearBlurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.nearBlurLevel),
    farBlurLevel: bounded(value.farBlurLevel, 0, 1_000, DEFAULT_CAMERA_OPTICS.farBlurLevel),
    renderQuality: bounded(value.renderQuality, 1, 100, DEFAULT_CAMERA_OPTICS.renderQuality),
  };
}

/**
 * Returns a signed circle-of-confusion radius in render pixels. Negative values represent the near
 * field and positive values the far field. The result scales linearly with preview resolution while
 * retaining the same lens, focus, and blur controls.
 */
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
  const pixelsPerMillimeter =
    bounded(compositionWidth, 1, 32_768, 1920) / Math.max(optics.filmSize, MIN_POSITIVE);
  const aperturePixels = Math.max(optics.aperture, 0) * pixelsPerMillimeter;
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
