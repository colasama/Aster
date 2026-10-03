/** Default RAM budget for finished preview frames; zero disables the cache. */
export const DEFAULT_FRAME_CACHE_BUDGET_MB = 2_048;
export const MAX_FRAME_CACHE_BUDGET_MB = 65_536;

export function isFrameCacheBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_FRAME_CACHE_BUDGET_MB
  );
}

export function normalizeFrameCacheBudget(value: unknown): number {
  return isFrameCacheBudget(value) ? value : DEFAULT_FRAME_CACHE_BUDGET_MB;
}

/** Index of the composition frame that contains `time`, tolerant of float drift at boundaries. */
export function compositionFrameIndex(
  time: number,
  frameRate: { numerator: number; denominator: number },
): number {
  return Math.floor((time * frameRate.numerator) / frameRate.denominator + 1e-6);
}

export function compositionFrameTime(
  frame: number,
  frameRate: { numerator: number; denominator: number },
): number {
  return (frame * frameRate.denominator) / frameRate.numerator;
}
