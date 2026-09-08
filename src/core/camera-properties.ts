import { DEFAULT_CAMERA_APERTURE_PIXELS } from "./camera-optics";
import { evaluateAnimatable, insertKeyframe } from "./timeline";
import type { Animatable, CameraSettings } from "./types";

export const CAMERA_ANIMATABLE_FIELDS = [
  "zoom",
  "filmSize",
  "orthographicSize",
  "focusDistance",
  "aperture",
  "blurLevel",
  "focusAreaWidth",
  "nearBlurLevel",
  "farBlurLevel",
  "irisRotation",
  "irisRoundness",
  "irisAspectRatio",
  "irisDiffractionFringe",
  "highlightGain",
  "highlightThreshold",
  "highlightSaturation",
] as const;

export type CameraAnimatableField = (typeof CAMERA_ANIMATABLE_FIELDS)[number];

export interface CameraPropertyLimit {
  minimum: number;
  maximum: number;
  fallback: number;
}

export const CAMERA_PROPERTY_LIMITS: Readonly<Record<CameraAnimatableField, CameraPropertyLimit>> =
  {
    zoom: { minimum: 0.1, maximum: 1_000_000, fallback: 2666.666_666_666_666_5 },
    filmSize: { minimum: 0.1, maximum: 1_000, fallback: 36 },
    orthographicSize: { minimum: 1, maximum: 10_000_000, fallback: 1080 },
    focusDistance: { minimum: 0.1, maximum: 10_000_000, fallback: 2666.666_666_666_666_5 },
    aperture: { minimum: 0.001, maximum: 10_000, fallback: DEFAULT_CAMERA_APERTURE_PIXELS },
    blurLevel: { minimum: 0, maximum: 1_000, fallback: 100 },
    focusAreaWidth: { minimum: 0, maximum: 10_000_000, fallback: 0 },
    nearBlurLevel: { minimum: 0, maximum: 1_000, fallback: 100 },
    farBlurLevel: { minimum: 0, maximum: 1_000, fallback: 100 },
    irisRotation: { minimum: -360, maximum: 360, fallback: 0 },
    irisRoundness: { minimum: 0, maximum: 100, fallback: 0 },
    irisAspectRatio: { minimum: 1, maximum: 100, fallback: 1 },
    irisDiffractionFringe: { minimum: 0, maximum: 100, fallback: 0 },
    highlightGain: { minimum: 0, maximum: 100, fallback: 0 },
    highlightThreshold: { minimum: 0, maximum: 1, fallback: 1 },
    highlightSaturation: { minimum: 0, maximum: 100, fallback: 100 },
  };

export function isCameraAnimatableField(value: string): value is CameraAnimatableField {
  return (CAMERA_ANIMATABLE_FIELDS as readonly string[]).includes(value);
}

export function normalizeCameraAnimatable(
  value: Animatable | number | undefined,
  field: CameraAnimatableField,
  fallbackOverride?: number,
): Animatable {
  const limit = CAMERA_PROPERTY_LIMITS[field];
  const fallback = clamp(fallbackOverride ?? limit.fallback, limit);
  if (typeof value === "number") return { mode: "static", value: clamp(value, limit, fallback) };
  if (!value || typeof value !== "object") return { mode: "static", value: fallback };
  if (value.mode === "static")
    return { mode: "static", value: clamp(value.value, limit, fallback) };
  if (value.mode !== "animated" || !Array.isArray(value.keyframes) || value.keyframes.length === 0)
    return { mode: "static", value: fallback };
  const keyframes = value.keyframes
    .filter(
      (keyframe) =>
        keyframe && Number.isFinite(keyframe.time) && keyframe.time >= 0 && keyframe.id.length > 0,
    )
    .map((keyframe) => ({ ...keyframe, value: clamp(keyframe.value, limit, fallback) }))
    .sort((left, right) => left.time - right.time);
  return keyframes.length ? { mode: "animated", keyframes } : { mode: "static", value: fallback };
}

export function evaluateCameraProperty(
  camera: CameraSettings,
  field: CameraAnimatableField,
  time: number,
): number {
  return clamp(evaluateAnimatable(camera[field], time), CAMERA_PROPERTY_LIMITS[field]);
}

/** Preserve animation while editing a Camera Options value at the current timeline time. */
export function setCameraPropertyAtTime(
  camera: CameraSettings,
  field: CameraAnimatableField,
  time: number,
  value: number,
): CameraSettings {
  const nextValue = clamp(value, CAMERA_PROPERTY_LIMITS[field]);
  const property = camera[field];
  const unlockFocus = field === "zoom" || field === "focusDistance";
  if (property.mode === "static")
    return {
      ...camera,
      [field]: { mode: "static", value: nextValue },
      ...(unlockFocus ? { lockFocusToZoom: false } : {}),
    };
  const exact = property.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= 0.000_001);
  if (exact) {
    return {
      ...camera,
      ...(unlockFocus ? { lockFocusToZoom: false } : {}),
      [field]: {
        mode: "animated",
        keyframes: property.keyframes.map((keyframe) =>
          keyframe.id === exact.id ? { ...keyframe, value: nextValue } : keyframe,
        ),
      },
    };
  }
  return {
    ...camera,
    ...(unlockFocus ? { lockFocusToZoom: false } : {}),
    [field]: insertKeyframe(property, {
      id: `camera-${field}-${Math.max(0, Math.round(time * 1_000_000))}`,
      time: Math.max(0, time),
      value: nextValue,
      interpolation: "linear",
    }),
  };
}

function clamp(value: number, limit: CameraPropertyLimit, fallback = limit.fallback): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(limit.maximum, Math.max(limit.minimum, finite));
}
