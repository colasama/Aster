import { collectEditableKeyframes } from "../core/keyframe-editing";
import type { Operation } from "../core/operations";
import {
  moveLayerTimingGroup,
  normalizeWorkArea,
  type TimelineSnapTarget,
  trimLayerTimingGroup,
} from "../core/timeline-editing";
import type { Composition, Id, Layer } from "../core/types";

export type TimelineWorkArea = Composition["workArea"];

export interface TimelineContentPoint {
  x: number;
  y: number;
}

export interface TimelineViewportSnapshot {
  left: number;
  scrollLeft: number;
  scrollTop: number;
  top: number;
}

export type LayerTimingDrag = "move" | "trim-in" | "trim-out";

export type TimelineShortcut =
  | "work-start"
  | "work-end"
  | "previous-event"
  | "next-event"
  | "composition-start"
  | "composition-end"
  | "previous-frame"
  | "next-frame"
  | "align-in"
  | "align-out"
  | "trim-in"
  | "trim-out";

export interface ShortcutLike {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}

export function compositionFrameDuration(composition: Composition): number {
  return composition.frameRate.denominator / composition.frameRate.numerator;
}

export function timelineContentPoint(
  clientX: number,
  clientY: number,
  viewport: TimelineViewportSnapshot,
): TimelineContentPoint {
  return {
    x: clientX - viewport.left + viewport.scrollLeft,
    y: clientY - viewport.top + viewport.scrollTop,
  };
}

export function timelineMarqueeRect(
  start: TimelineContentPoint,
  current: TimelineContentPoint,
  labelWidth: number,
): { height: number; left: number; top: number; width: number } {
  const left = Math.max(labelWidth, Math.min(start.x, current.x));
  const right = Math.max(labelWidth, Math.max(start.x, current.x));
  return {
    left,
    top: Math.min(start.y, current.y),
    width: right - left,
    height: Math.abs(current.y - start.y),
  };
}

export function buildTimelineSnapTargets(
  composition: Composition,
  playhead: number,
  workArea: TimelineWorkArea,
): TimelineSnapTarget[] {
  return [
    { time: playhead, kind: "playhead" },
    { time: workArea.start, kind: "work-area" },
    { time: workArea.end, kind: "work-area" },
    ...composition.layers.flatMap((layer) => [
      { id: layer.id, time: layer.inPoint, kind: "layer-in" as const },
      { id: layer.id, time: layer.outPoint, kind: "layer-out" as const },
    ]),
    ...collectEditableKeyframes(composition).map((entry) => ({
      id: entry.keyframe.id,
      time: entry.keyframe.time,
      kind: "keyframe" as const,
    })),
  ];
}

export function excludeTimelineSnapTargets(
  targets: readonly TimelineSnapTarget[],
  excludedIds: readonly Id[],
): TimelineSnapTarget[] {
  const excluded = new Set(excludedIds);
  return targets.filter((target) => !target.id || !excluded.has(target.id));
}

export function editLayerTimingGroup(
  layers: readonly Layer[],
  activeLayerId: Id,
  mode: LayerTimingDrag,
  requestedTime: number,
  composition: Composition,
  pixelsPerSecond: number,
  targets: readonly TimelineSnapTarget[],
  bypassSnap: boolean,
) {
  const timings = layers.map(({ id, inPoint, outPoint }) => ({ id, inPoint, outPoint }));
  const frameDuration = compositionFrameDuration(composition);
  return mode === "move"
    ? moveLayerTimingGroup(
        timings,
        activeLayerId,
        requestedTime,
        composition.duration,
        frameDuration,
        pixelsPerSecond,
        targets,
        bypassSnap,
      )
    : trimLayerTimingGroup(
        timings,
        mode === "trim-in" ? "in" : "out",
        activeLayerId,
        requestedTime,
        composition.duration,
        frameDuration,
        pixelsPerSecond,
        targets,
        bypassSnap,
      );
}

export function layerTimingOperations(
  timings: readonly { id: Id; inPoint: number; outPoint: number }[],
): Operation[] {
  return timings.map((timing) => ({
    type: "setLayerTiming",
    layerId: timing.id,
    inPoint: timing.inPoint,
    outPoint: timing.outPoint,
  }));
}

export function setWorkAreaBoundary(
  workArea: TimelineWorkArea,
  edge: "start" | "end",
  requestedTime: number,
  duration: number,
  frameDuration: number,
): TimelineWorkArea {
  const time = Math.max(0, Math.min(duration, requestedTime));
  if (edge === "start") {
    const end = time >= workArea.end ? Math.min(duration, time + frameDuration) : workArea.end;
    return normalizeWorkArea(time, end, duration, frameDuration);
  }
  const start = time <= workArea.start ? Math.max(0, time - frameDuration) : workArea.start;
  return normalizeWorkArea(start, time, duration, frameDuration);
}

export function moveWorkArea(
  workArea: TimelineWorkArea,
  requestedStart: number,
  duration: number,
  frameDuration: number,
): TimelineWorkArea {
  const length = workArea.end - workArea.start;
  const start = Math.max(0, Math.min(duration - length, requestedStart));
  return normalizeWorkArea(start, start + length, duration, frameDuration);
}

export function resolveTimelineShortcut(input: ShortcutLike): TimelineShortcut | undefined {
  if (input.ctrlKey || input.metaKey) return undefined;
  if (input.code === "BracketLeft") return input.altKey ? "trim-in" : "align-in";
  if (input.code === "BracketRight") return input.altKey ? "trim-out" : "align-out";
  if (input.altKey) return undefined;
  switch (input.key.toLowerCase()) {
    case "b":
      return "work-start";
    case "n":
      return "work-end";
    case "j":
      return "previous-event";
    case "k":
      return "next-event";
    case "home":
      return "composition-start";
    case "end":
      return "composition-end";
    case "pageup":
      return "previous-frame";
    case "pagedown":
      return "next-frame";
    default:
      return undefined;
  }
}

export function collectTimelineEventTimes(
  composition: Composition,
  workArea: TimelineWorkArea,
): number[] {
  return [
    0,
    composition.duration,
    workArea.start,
    workArea.end,
    ...composition.layers.flatMap((layer) => [layer.inPoint, layer.outPoint]),
    ...collectEditableKeyframes(composition).map((entry) => entry.keyframe.time),
  ];
}
