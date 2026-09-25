import { useEffect, useState, useSyncExternalStore } from "react";
import { TIMELINE_BASE_SCALE } from "../../ui/timeline-zoom";

export const TIMELINE_PPS_VAR = "--timeline-pps";
const SETTLE_DELAY_MS = 140;

let zoom = 1;
const surfaces = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const settleListeners = new Set<() => void>();
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function writeScale(surface: HTMLElement) {
  surface.style.setProperty(TIMELINE_PPS_VAR, `${zoom * TIMELINE_BASE_SCALE}px`);
}

export function timelinePixelsPerSecond() {
  return zoom * TIMELINE_BASE_SCALE;
}

/**
 * Timeline zoom lives outside the editor store so a wheel/drag gesture only
 * touches the timeline surface: positioned children read `--timeline-pps`
 * through CSS calc() and never re-render; React subscribers are limited to the
 * ruler and the zoom controls.
 */
export const timelineZoomStore = {
  get: () => zoom,
  set(next: number) {
    if (!Number.isFinite(next) || next === zoom) return;
    zoom = next;
    for (const surface of surfaces) writeScale(surface);
    for (const listener of listeners) listener();
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      for (const listener of settleListeners) listener();
    }, SETTLE_DELAY_MS);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  subscribeSettled(listener: () => void) {
    settleListeners.add(listener);
    return () => {
      settleListeners.delete(listener);
    };
  },
  attachSurface(surface: HTMLElement) {
    surfaces.add(surface);
    writeScale(surface);
    return () => {
      surfaces.delete(surface);
    };
  },
};

export function useTimelineZoom() {
  return useSyncExternalStore(timelineZoomStore.subscribe, timelineZoomStore.get);
}

/** Scale sampled only once a zoom gesture settles; used by content redrawn as a bitmap. */
export function useTimelineSettledPixelsPerSecond() {
  const [scale, setScale] = useState(timelinePixelsPerSecond);
  useEffect(
    () => timelineZoomStore.subscribeSettled(() => setScale(timelinePixelsPerSecond())),
    [],
  );
  return scale;
}
