import type { Id } from "./types";

const DEFAULT_SNAP_THRESHOLD_PX = 8;
const EPSILON = 1e-7;
const MINIMUM_LAYER_DURATION = 1 / 240;

export type TimelineSnapKind =
  | "frame"
  | "playhead"
  | "layer-in"
  | "layer-out"
  | "keyframe"
  | "work-area";

export interface TimelineSnapTarget {
  time: number;
  kind: Exclude<TimelineSnapKind, "frame">;
  id?: Id;
}

export interface TimelineSnapResult {
  time: number;
  kind: TimelineSnapKind;
  targetId?: Id;
}

export interface LayerTiming {
  id: Id;
  inPoint: number;
  outPoint: number;
}

export interface TimelineSelectionPoint {
  id: Id;
  time: number;
  row: number;
}

/** Magnetic snap: frame quantization is the baseline, nearby edit points win in pixels. */
export function snapTimelineTime(
  requestedTime: number,
  frameDuration: number,
  pixelsPerSecond: number,
  targets: readonly TimelineSnapTarget[],
  bypass = false,
  thresholdPixels = DEFAULT_SNAP_THRESHOLD_PX,
): TimelineSnapResult {
  const requested = finiteNonNegative(requestedTime);
  if (bypass) return { time: requested, kind: "frame" };
  const frame = boundedFrameDuration(frameDuration);
  const frameTime = Math.round(requested / frame) * frame;
  const threshold =
    Math.max(0, finite(thresholdPixels, DEFAULT_SNAP_THRESHOLD_PX)) /
    Math.max(1, finite(pixelsPerSecond, 1));
  let winner: TimelineSnapResult = { time: frameTime, kind: "frame" };
  let distance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (!Number.isFinite(target.time) || target.time < 0) continue;
    const nextDistance = Math.abs(target.time - requested);
    if (nextDistance > threshold + EPSILON || nextDistance >= distance - EPSILON) continue;
    winner = { time: target.time, kind: target.kind, targetId: target.id };
    distance = nextDistance;
  }
  return winner;
}

/** Moves a selected layer group as one editing transaction while preserving offsets and duration. */
export function moveLayerTimingGroup(
  layers: readonly LayerTiming[],
  activeLayerId: Id,
  requestedActiveIn: number,
  compositionDuration: number,
  frameDuration: number,
  pixelsPerSecond: number,
  targets: readonly TimelineSnapTarget[] = [],
  bypassSnap = false,
): LayerTiming[] {
  const active = layers.find((layer) => layer.id === activeLayerId);
  if (!active || layers.length === 0) return [];
  const duration = finiteNonNegative(compositionDuration);
  const snapped = snapTimelineTime(
    requestedActiveIn,
    frameDuration,
    pixelsPerSecond,
    targets.filter((target) => !layers.some((layer) => layer.id === target.id)),
    bypassSnap,
  ).time;
  const requestedDelta = snapped - active.inPoint;
  const minimumDelta = -Math.min(...layers.map((layer) => layer.inPoint));
  const maximumDelta = duration - Math.max(...layers.map((layer) => layer.outPoint));
  const delta = clamp(requestedDelta, minimumDelta, maximumDelta);
  return layers.map((layer) => ({
    id: layer.id,
    inPoint: layer.inPoint + delta,
    outPoint: layer.outPoint + delta,
  }));
}

/** Trims matching group edges without shrinking valid sub-frame layers or crossing one frame. */
export function trimLayerTimingGroup(
  layers: readonly LayerTiming[],
  edge: "in" | "out",
  activeLayerId: Id,
  requestedTime: number,
  compositionDuration: number,
  frameDuration: number,
  pixelsPerSecond: number,
  targets: readonly TimelineSnapTarget[] = [],
  bypassSnap = false,
): LayerTiming[] {
  const active = layers.find((layer) => layer.id === activeLayerId);
  if (!active || layers.length === 0) return [];
  const frame = boundedFrameDuration(frameDuration);
  const current = edge === "in" ? active.inPoint : active.outPoint;
  const snapped = snapTimelineTime(
    requestedTime,
    frame,
    pixelsPerSecond,
    targets.filter((target) => !layers.some((layer) => layer.id === target.id)),
    bypassSnap,
  ).time;
  const requestedDelta = snapped - current;
  const duration = finiteNonNegative(compositionDuration);
  const minimumLengths = layers.map((layer) =>
    Math.min(
      frame,
      Math.max(MINIMUM_LAYER_DURATION, finiteNonNegative(layer.outPoint - layer.inPoint)),
    ),
  );
  const minimumDelta =
    edge === "in" ? -Math.min(...layers.map((layer) => layer.inPoint)) : -Infinity;
  const maximumDelta =
    edge === "in"
      ? Math.min(
          ...layers.map((layer, index) => layer.outPoint - layer.inPoint - minimumLengths[index]),
        )
      : duration - Math.max(...layers.map((layer) => layer.outPoint));
  const minimumOutDelta =
    edge === "out"
      ? Math.max(
          ...layers.map((layer, index) => layer.inPoint + minimumLengths[index] - layer.outPoint),
        )
      : -Infinity;
  const lowerBound = Math.max(minimumDelta, minimumOutDelta);
  const delta = lowerBound <= maximumDelta ? clamp(requestedDelta, lowerBound, maximumDelta) : 0;
  return layers.map((layer) => ({
    id: layer.id,
    inPoint: edge === "in" ? layer.inPoint + delta : layer.inPoint,
    outPoint: edge === "out" ? layer.outPoint + delta : layer.outPoint,
  }));
}

export function normalizeWorkArea(
  start: number,
  end: number,
  duration: number,
  frameDuration: number,
): { start: number; end: number } {
  const maximum = finiteNonNegative(duration);
  const frame = boundedFrameDuration(frameDuration);
  const snappedStart = clamp(Math.round(finiteNonNegative(start) / frame) * frame, 0, maximum);
  const snappedEnd = clamp(Math.round(finiteNonNegative(end) / frame) * frame, 0, maximum);
  if (snappedEnd - snappedStart >= frame - EPSILON) return { start: snappedStart, end: snappedEnd };
  if (snappedStart + frame <= maximum) return { start: snappedStart, end: snappedStart + frame };
  return { start: Math.max(0, maximum - frame), end: maximum };
}

/** Selects keyframes intersecting an inclusive time/row marquee. */
export function marqueeTimelineSelection(
  points: readonly TimelineSelectionPoint[],
  timeA: number,
  timeB: number,
  rowA: number,
  rowB: number,
): Id[] {
  const minimumTime = Math.min(finiteNonNegative(timeA), finiteNonNegative(timeB));
  const maximumTime = Math.max(finiteNonNegative(timeA), finiteNonNegative(timeB));
  const minimumRow = Math.min(Math.floor(finite(rowA, 0)), Math.floor(finite(rowB, 0)));
  const maximumRow = Math.max(Math.floor(finite(rowA, 0)), Math.floor(finite(rowB, 0)));
  return points
    .filter(
      (point) =>
        Number.isFinite(point.time) &&
        point.time >= minimumTime - EPSILON &&
        point.time <= maximumTime + EPSILON &&
        point.row >= minimumRow &&
        point.row <= maximumRow,
    )
    .map((point) => point.id);
}

/** Implements J/K-style navigation without making the result depend on insertion order. */
export function adjacentTimelineEvent(
  times: readonly number[],
  currentTime: number,
  direction: -1 | 1,
): number | undefined {
  const current = finiteNonNegative(currentTime);
  const unique = [...new Set(times.filter((time) => Number.isFinite(time) && time >= 0))].sort(
    (left, right) => left - right,
  );
  if (direction > 0) return unique.find((time) => time > current + EPSILON);
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    if (unique[index] < current - EPSILON) return unique[index];
  }
  return undefined;
}

function boundedFrameDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(1, value) : 1 / 60;
}

function finiteNonNegative(value: number): number {
  return Math.max(0, finite(value, 0));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
