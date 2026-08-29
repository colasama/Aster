import type { GraphTrack } from "./model";

export const GRAPH_WIDTH = 1_000;
export const GRAPH_HEIGHT = 260;
export const GRAPH_PADDING = 20;

export interface GraphTimeRange {
  start: number;
  end: number;
}

export interface GraphValueRange {
  min: number;
  max: number;
}

export function graphMarkerRadii(viewportWidth: number, viewportHeight: number, radius: number) {
  return {
    x: viewportWidth > 0 ? (radius * GRAPH_WIDTH) / viewportWidth : radius,
    y: viewportHeight > 0 ? (radius * GRAPH_HEIGHT) / viewportHeight : radius,
  };
}

export function timeToGraphX(time: number, range: GraphTimeRange): number {
  return ((time - range.start) / nonZeroSpan(range.end - range.start)) * GRAPH_WIDTH;
}

export function graphXToTime(x: number, range: GraphTimeRange): number {
  return range.start + (x / GRAPH_WIDTH) * (range.end - range.start);
}

export function valueToGraphY(value: number, range: GraphValueRange): number {
  const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING * 2;
  return (
    GRAPH_HEIGHT -
    GRAPH_PADDING -
    ((value - range.min) / nonZeroSpan(range.max - range.min)) * innerHeight
  );
}

export function graphYToValue(y: number, range: GraphValueRange): number {
  const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING * 2;
  return (
    range.min +
    ((GRAPH_HEIGHT - GRAPH_PADDING - y) / nonZeroSpan(innerHeight)) * (range.max - range.min)
  );
}

export function fitGraphTimeRange(
  tracks: readonly GraphTrack[],
  compositionDuration: number,
  selectedKeyframes?: ReadonlySet<string>,
): GraphTimeRange {
  const selectedOnly = Boolean(selectedKeyframes?.size);
  const times: number[] = [];
  for (const track of tracks)
    for (const keyframe of track.property.keyframes)
      if (!selectedOnly || selectedKeyframes?.has(keyframe.id)) times.push(keyframe.time);
  if (times.length === 0) return { start: 0, end: Math.max(compositionDuration, Number.EPSILON) };
  let start = Math.min(...times);
  let end = Math.max(...times);
  const minimumSpan = Math.max(compositionDuration / 100, 1 / 120);
  if (end - start < minimumSpan) {
    const center = (start + end) / 2;
    start = center - minimumSpan / 2;
    end = center + minimumSpan / 2;
  } else {
    const padding = (end - start) * 0.06;
    start -= padding;
    end += padding;
  }
  return clampGraphTimeRange({ start, end }, compositionDuration);
}

export function panGraphTimeRange(
  range: GraphTimeRange,
  delta: number,
  compositionDuration: number,
): GraphTimeRange {
  return clampGraphTimeRange(
    { start: range.start + delta, end: range.end + delta },
    compositionDuration,
  );
}

export function zoomGraphTimeRange(
  range: GraphTimeRange,
  anchorTime: number,
  factor: number,
  compositionDuration: number,
  minimumSpan = 1 / 1_000,
): GraphTimeRange {
  const span = Math.max(minimumSpan, range.end - range.start);
  const ratio = (anchorTime - range.start) / span;
  const nextSpan = Math.min(
    Math.max(compositionDuration, minimumSpan),
    Math.max(minimumSpan, span * boundedFactor(factor)),
  );
  return clampGraphTimeRange(
    {
      start: anchorTime - nextSpan * ratio,
      end: anchorTime + nextSpan * (1 - ratio),
    },
    compositionDuration,
  );
}

export function panGraphValueRange(range: GraphValueRange, delta: number): GraphValueRange {
  const finiteDelta = Number.isFinite(delta) ? delta : 0;
  return { min: range.min + finiteDelta, max: range.max + finiteDelta };
}

export function zoomGraphValueRange(
  range: GraphValueRange,
  anchorValue: number,
  factor: number,
): GraphValueRange {
  const span = nonZeroSpan(range.max - range.min);
  const ratio = (anchorValue - range.min) / span;
  const nextSpan = Math.max(1e-9, span * boundedFactor(factor));
  return {
    min: anchorValue - nextSpan * ratio,
    max: anchorValue + nextSpan * (1 - ratio),
  };
}

export function snapGraphTime(
  time: number,
  frameDuration: number,
  currentTime: number,
  pixelsPerSecond: number,
  bypass = false,
  targets: readonly number[] = [],
  allowBetweenFrames = false,
): number {
  if (!Number.isFinite(time)) return 0;
  if (bypass) return time;
  const frame = Number.isFinite(frameDuration) && frameDuration > 0 ? frameDuration : 1 / 60;
  const frameTime = Math.round(time / frame) * frame;
  const snapDistance = 8 / Math.max(1, pixelsPerSecond);
  let nearest = Number.isFinite(currentTime) ? currentTime : frameTime;
  let nearestDistance = Math.abs(nearest - time);
  for (const target of targets) {
    if (!Number.isFinite(target)) continue;
    const distance = Math.abs(target - time);
    if (distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  if (nearestDistance <= snapDistance) return nearest;
  return allowBetweenFrames ? time : frameTime;
}

export function clampGraphTimeRange(
  range: GraphTimeRange,
  compositionDuration: number,
): GraphTimeRange {
  const duration = Math.max(Number.EPSILON, finiteOr(compositionDuration, 0));
  const requestedSpan = Math.max(Number.EPSILON, finiteOr(range.end - range.start, duration));
  if (requestedSpan >= duration) return { start: 0, end: duration };
  let start = finiteOr(range.start, 0);
  let end = start + requestedSpan;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > duration) {
    start -= end - duration;
    end = duration;
  }
  return { start: Math.max(0, start), end };
}

function boundedFactor(value: number): number {
  return Number.isFinite(value) ? Math.min(20, Math.max(0.05, value)) : 1;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonZeroSpan(value: number): number {
  return Number.isFinite(value) && Math.abs(value) > 1e-12 ? value : 1e-12;
}
