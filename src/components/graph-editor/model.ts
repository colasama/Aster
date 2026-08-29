import { type GraphSampleBuffer, sampleGraph } from "../../core/graph-sampling";
import { getProperty, type PropertyPath } from "../../core/operations";
import { evaluateAnimatable } from "../../core/timeline";
import type { Animatable, Layer } from "../../core/types";
import type { PlainMessageKey } from "../../i18n/core";

export type GraphType = "auto" | "value" | "speed";
export type ResolvedGraphType = Exclude<GraphType, "auto">;
type AnimatedProperty = Extract<Animatable, { mode: "animated" }>;

export interface GraphTrack {
  id: PropertyPath;
  path: PropertyPath;
  labelKey: PlainMessageKey;
  color: string;
  step: number;
  property: AnimatedProperty;
}

export interface GraphKeyframePreview {
  trackId: PropertyPath;
  keyframeId: string;
  time: number;
  value: number;
}

export interface GraphEasingPreview {
  trackId: PropertyPath;
  keyframeId: string;
  easing: [number, number, number, number];
}

export interface GraphCurve {
  track: GraphTrack;
  type: ResolvedGraphType;
  samples: GraphSampleBuffer;
}

const TRACK_DEFINITIONS: ReadonlyArray<
  Omit<GraphTrack, "property"> & { labelKey: PlainMessageKey }
> = [
  {
    id: "position.0",
    path: "position.0",
    labelKey: "timeline.property.positionX",
    color: "#ef6678",
    step: 0.1,
  },
  {
    id: "position.1",
    path: "position.1",
    labelKey: "timeline.property.positionY",
    color: "#65d787",
    step: 0.1,
  },
  {
    id: "position.2",
    path: "position.2",
    labelKey: "timeline.property.positionZ",
    color: "#6795f8",
    step: 0.1,
  },
  {
    id: "rotation.0",
    path: "rotation.0",
    labelKey: "timeline.property.rotationX",
    color: "#f4a261",
    step: 0.1,
  },
  {
    id: "rotation.1",
    path: "rotation.1",
    labelKey: "timeline.property.rotationY",
    color: "#ad8cff",
    step: 0.1,
  },
  {
    id: "rotation.2",
    path: "rotation.2",
    labelKey: "timeline.property.rotationZ",
    color: "#31c8bd",
    step: 0.1,
  },
  {
    id: "scale.0",
    path: "scale.0",
    labelKey: "timeline.property.scaleX",
    color: "#f07ac0",
    step: 0.1,
  },
  {
    id: "scale.1",
    path: "scale.1",
    labelKey: "timeline.property.scaleY",
    color: "#e7c84f",
    step: 0.1,
  },
  {
    id: "scale.2",
    path: "scale.2",
    labelKey: "timeline.property.scaleZ",
    color: "#45bfe9",
    step: 0.1,
  },
  {
    id: "opacity",
    path: "opacity",
    labelKey: "timeline.property.opacity",
    color: "#c1a7ff",
    step: 1,
  },
];

export function collectAnimatedGraphTracks(layer: Layer | undefined): GraphTrack[] {
  if (!layer) return [];
  return TRACK_DEFINITIONS.flatMap((definition) => {
    const property = getProperty(layer, definition.path);
    return property.mode === "animated" && property.keyframes.length > 0
      ? [{ ...definition, property }]
      : [];
  });
}

export function resolveGraphType(
  type: GraphType,
  track: Pick<GraphTrack, "path">,
): ResolvedGraphType {
  if (type !== "auto") return type;
  return track.path.startsWith("position.") ? "speed" : "value";
}

export function previewGraphTrack(
  track: GraphTrack,
  keyframePreview?: GraphKeyframePreview,
  easingPreview?: GraphEasingPreview,
): GraphTrack {
  if (keyframePreview?.trackId !== track.id && easingPreview?.trackId !== track.id) return track;
  const keyframes = track.property.keyframes
    .map((keyframe) => {
      let previewed = keyframe;
      if (keyframePreview?.trackId === track.id && keyframePreview.keyframeId === keyframe.id)
        previewed = { ...previewed, time: keyframePreview.time, value: keyframePreview.value };
      if (easingPreview?.trackId === track.id && easingPreview.keyframeId === keyframe.id)
        previewed = { ...previewed, interpolation: "bezier", easing: easingPreview.easing };
      return previewed;
    })
    .sort((left, right) => left.time - right.time);
  return { ...track, property: { mode: "animated", keyframes } };
}

export function sampleGraphTrack(
  track: GraphTrack,
  type: GraphType,
  startTime: number,
  endTime: number,
  pixelWidth: number,
  target?: GraphSampleBuffer,
): GraphCurve {
  return {
    track,
    type: resolveGraphType(type, track),
    samples: sampleGraph({
      evaluate: (time) => evaluateAnimatable(track.property, time),
      startTime,
      endTime,
      pixelWidth,
      samplesPerPixel: 1,
      target,
    }),
  };
}

export function graphCurveValue(curve: GraphCurve, index: number): number {
  return curve.type === "value" ? curve.samples.values[index] : curve.samples.speeds[index];
}

export function graphCurveValueAtTime(curve: GraphCurve, time: number): number {
  const { count, times } = curve.samples;
  if (count <= 1 || time <= times[0]) return graphCurveValue(curve, 0);
  if (time >= times[count - 1]) return graphCurveValue(curve, count - 1);
  let low = 1;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  const after = low;
  const before = after - 1;
  const span = times[after] - times[before];
  if (span <= 0) return graphCurveValue(curve, after);
  const progress = (time - times[before]) / span;
  return graphCurveValue(curve, before) * (1 - progress) + graphCurveValue(curve, after) * progress;
}

export function graphDraggedKeyframeValue(
  type: ResolvedGraphType,
  keyframeValue: number,
  graphValue: number,
): number {
  return type === "value" && Number.isFinite(graphValue) ? graphValue : keyframeValue;
}

export function graphCurveRange(curves: readonly GraphCurve[]): { min: number; max: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const curve of curves) {
    for (let index = 0; index < curve.samples.count; index += 1) {
      if (!curve.samples.validity[index]) continue;
      const value = graphCurveValue(curve, index);
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return { min: -1, max: 1 };
  const span = maximum - minimum;
  const padding = Math.max(0.001, span * 0.08, Math.abs(maximum) * 0.002);
  return { min: minimum - padding, max: maximum + padding };
}
