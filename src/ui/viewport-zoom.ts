export const MIN_VIEWPORT_ZOOM = 0.25;
export const MAX_VIEWPORT_ZOOM = 8;
export const DEFAULT_VIEWPORT_ZOOM = 0.25;
export const VIEWPORT_ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function normalizeViewportZoom(value: number, fallback = DEFAULT_VIEWPORT_ZOOM): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, finite));
}

export function viewportZoomPercent(value: number): number {
  return Math.round(normalizeViewportZoom(value) * 100);
}
