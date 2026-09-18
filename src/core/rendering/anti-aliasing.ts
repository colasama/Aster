export const ANTI_ALIASING_MODES = ["off", "fxaa", "ssaa2x", "ssaa4x"] as const;
export type AntiAliasingMode = (typeof ANTI_ALIASING_MODES)[number];
export const DEFAULT_ANTI_ALIASING: AntiAliasingMode = "fxaa";

export function isAntiAliasingMode(value: unknown): value is AntiAliasingMode {
  return ANTI_ALIASING_MODES.includes(value as AntiAliasingMode);
}

export function normalizeAntiAliasing(value: unknown): AntiAliasingMode {
  return isAntiAliasingMode(value) ? value : "off";
}

/** SSAA labels describe the multiplier on each dimension, not the total sample count. */
export function antiAliasingScale(mode: AntiAliasingMode): number {
  return mode === "ssaa4x" ? 4 : mode === "ssaa2x" ? 2 : 1;
}
