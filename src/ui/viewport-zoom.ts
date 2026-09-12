export const MIN_VIEWPORT_ZOOM = 0.01;
export const MAX_VIEWPORT_ZOOM = 8;
export const DEFAULT_VIEWPORT_ZOOM = 0.25;
export const VIEWPORT_ZOOM_PRESETS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8] as const;

export type ViewportZoomMode = "fit" | "fit100" | "manual";

export function fitViewportZoom(
  width: number,
  height: number,
  compositionWidth: number,
  compositionHeight: number,
  viewCount = 1,
  cap = MAX_VIEWPORT_ZOOM,
): number {
  if (
    ![width, height, compositionWidth, compositionHeight].every((n) => Number.isFinite(n) && n > 0)
  )
    return MIN_VIEWPORT_ZOOM;
  const count = viewCount === 2 ? 2 : 1;
  return normalizeViewportZoom(
    Math.min(
      cap,
      Math.max(1, width - 64 - (count - 1) * 32) / (compositionWidth * count),
      Math.max(1, height - 64) / compositionHeight,
    ),
  );
}

export function normalizeViewportZoom(value: number, fallback = DEFAULT_VIEWPORT_ZOOM): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, finite));
}

export function viewportZoomPercent(value: number): number {
  return Math.round(normalizeViewportZoom(value) * 100);
}
