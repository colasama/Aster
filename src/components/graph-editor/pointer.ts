import type { Keyframe } from "../../core/types";
import {
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  type GraphTimeRange,
  type GraphValueRange,
  timeToGraphX,
  valueToGraphY,
} from "./viewport";

const POINTER_EPSILON = 0.000_001;

export function keyframePoint(
  keyframe: Pick<Keyframe, "time" | "value">,
  timeRange: GraphTimeRange,
  valueRange: GraphValueRange,
) {
  return {
    x: timeToGraphX(keyframe.time, timeRange),
    y: valueToGraphY(keyframe.value, valueRange),
  };
}

export function clientGraphPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const bounds = svg.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return {
    x: Math.max(0, Math.min(GRAPH_WIDTH, ((clientX - bounds.left) / width) * GRAPH_WIDTH)),
    y: Math.max(0, Math.min(GRAPH_HEIGHT, ((clientY - bounds.top) / height) * GRAPH_HEIGHT)),
  };
}

export function signedNonZero(value: number): number {
  if (Math.abs(value) > POINTER_EPSILON) return value;
  return value < 0 ? -1 : 1;
}

export function addWindowPointerListeners(
  move: (event: PointerEvent) => void,
  end: () => void,
): void {
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

export function removeWindowPointerListeners(
  move: (event: PointerEvent) => void,
  end: () => void,
): void {
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", end);
  window.removeEventListener("pointercancel", end);
}
