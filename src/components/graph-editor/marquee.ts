import { type GraphCurve, graphCurveValueAtTime } from "./model";
import { type GraphTimeRange, type GraphValueRange, timeToGraphX, valueToGraphY } from "./viewport";

export interface GraphMarquee {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Keyframes whose plotted markers fall inside a graph-space rectangle, keyed by owning track. */
export function graphKeyframesInMarquee(
  curves: readonly GraphCurve[],
  marquee: GraphMarquee,
  timeRange: GraphTimeRange,
  valueRange: GraphValueRange,
): Record<string, string> {
  const left = Math.min(marquee.x0, marquee.x1);
  const right = Math.max(marquee.x0, marquee.x1);
  const top = Math.min(marquee.y0, marquee.y1);
  const bottom = Math.max(marquee.y0, marquee.y1);
  const owners: Record<string, string> = {};
  for (const curve of curves)
    for (const keyframe of curve.track.property.keyframes) {
      const x = timeToGraphX(keyframe.time, timeRange);
      const y = valueToGraphY(
        curve.type === "value" ? keyframe.value : graphCurveValueAtTime(curve, keyframe.time),
        valueRange,
      );
      if (x >= left && x <= right && y >= top && y <= bottom) owners[keyframe.id] = curve.track.id;
    }
  return owners;
}
