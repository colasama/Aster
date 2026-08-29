import { type GraphSampleBuffer, sampleGraph } from "../../core/graph-sampling";
import { getProperty, type PropertyPath } from "../../core/operations";
import { evaluateAnimatable, evaluateAnimatableSpeed } from "../../core/timeline";
import type { Animatable, Keyframe, Layer } from "../../core/types";
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
  /** Unseparated spatial components used to produce one AE-style speed magnitude. */
  spatialProperties?: readonly Animatable[];
  spatialPaths?: readonly PropertyPath[];
  spatialPrimary?: boolean;
  speedLabelKey?: PlainMessageKey;
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

export interface GraphSpeedSegment {
  outgoingSpeed: number;
  incomingSpeed: number;
  outgoingInfluence: number;
  incomingInfluence: number;
}

export type GraphEaseMode = "both" | "in" | "out";

export interface GraphEaseUpdate {
  keyframe: Keyframe;
  easing: [number, number, number, number];
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
  const animatedPositionPaths = TRACK_DEFINITIONS.filter((definition) =>
    definition.path.startsWith("position."),
  ).flatMap((definition) => {
    const property = getProperty(layer, definition.path);
    return property.mode === "animated" && property.keyframes.length > 0 ? [definition.path] : [];
  });
  const primaryPositionPath = animatedPositionPaths[0];
  return TRACK_DEFINITIONS.flatMap((definition) => {
    const property = getProperty(layer, definition.path);
    return property.mode === "animated" && property.keyframes.length > 0
      ? [
          {
            ...definition,
            property,
            ...(definition.path.startsWith("position.")
              ? {
                  spatialProperties: layer.transform.position,
                  spatialPaths: ["position.0", "position.1", "position.2"] as PropertyPath[],
                  spatialPrimary: definition.path === primaryPositionPath,
                  speedLabelKey: "graph.track.positionSpeed" as PlainMessageKey,
                }
              : {}),
          },
        ]
      : [];
  });
}

/** Hides duplicate component curves when an unseparated spatial property is shown as speed. */
export function graphTracksForType(tracks: readonly GraphTrack[], type: GraphType): GraphTrack[] {
  return tracks.filter(
    (track) =>
      !track.spatialProperties || resolveGraphType(type, track) === "value" || track.spatialPrimary,
  );
}

export function graphTrackLabelKey(track: GraphTrack, type: GraphType): PlainMessageKey {
  return resolveGraphType(type, track) === "speed" && track.speedLabelKey
    ? track.speedLabelKey
    : track.labelKey;
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
  const property = { mode: "animated" as const, keyframes };
  if (!track.spatialProperties || !track.spatialPaths) return { ...track, property };
  const activePreview = keyframePreview ?? easingPreview;
  const source = activePreview
    ? track.property.keyframes.find((keyframe) => keyframe.id === activePreview.keyframeId)
    : undefined;
  const component = track.spatialPaths.indexOf(track.path);
  const spatialProperties = track.spatialProperties.map((candidate, index) => {
    if (index === component) return property;
    if (!source || candidate.mode !== "animated") return candidate;
    return {
      mode: "animated" as const,
      keyframes: candidate.keyframes
        .map((keyframe) => {
          if (Math.abs(keyframe.time - source.time) > 0.000_001) return keyframe;
          if (keyframePreview) return { ...keyframe, time: keyframePreview.time };
          if (easingPreview)
            return {
              ...keyframe,
              interpolation: "bezier" as const,
              easing: easingPreview.easing,
            };
          return keyframe;
        })
        .sort((left, right) => left.time - right.time),
    };
  });
  return { ...track, property, spatialProperties };
}

export function sampleGraphTrack(
  track: GraphTrack,
  type: GraphType,
  startTime: number,
  endTime: number,
  pixelWidth: number,
  target?: GraphSampleBuffer,
  pixelHeight = 512,
): GraphCurve {
  const sampledType = resolveGraphType(type, track);
  const speedProperties = track.spatialProperties ?? [track.property];
  const evaluateSpeed = (time: number) =>
    Math.hypot(...speedProperties.map((property) => evaluateAnimatableSpeed(property, time)));
  const breakpoints = new Set<number>();
  for (const property of speedProperties)
    if (property.mode === "animated")
      for (const keyframe of property.keyframes) breakpoints.add(keyframe.time);
  return {
    track,
    type: sampledType,
    samples: sampleGraph({
      evaluate: (time) => evaluateAnimatable(track.property, time),
      evaluateSpeed,
      ...(sampledType === "speed" ? { adaptiveEvaluate: evaluateSpeed } : {}),
      startTime,
      endTime,
      pixelWidth,
      pixelHeight,
      samplesPerPixel: 1,
      breakpoints: [...breakpoints],
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

/**
 * Converts the temporal cubic stored on a segment into AE-style absolute speed and influence.
 * Influence is expressed as a normalized portion of the segment duration.
 */
export function graphSpeedSegment(
  start: Pick<Keyframe, "time" | "value" | "easing">,
  end: Pick<Keyframe, "time" | "value">,
  baseSpeedOverride?: number,
): GraphSpeedSegment {
  const duration = Math.max(Number.EPSILON, end.time - start.time);
  const baseSpeed =
    baseSpeedOverride === undefined
      ? Math.abs((end.value - start.value) / duration)
      : finiteSpeed(baseSpeedOverride);
  const [x1, y1, x2, y2] = start.easing ?? [0.42, 0, 0.58, 1];
  const outgoingInfluence = boundedInfluence(x1);
  const incomingInfluence = boundedInfluence(1 - x2);
  return {
    outgoingSpeed: finiteSpeed(baseSpeed * Math.abs(y1 / outgoingInfluence)),
    incomingSpeed: finiteSpeed(baseSpeed * Math.abs((1 - y2) / incomingInfluence)),
    outgoingInfluence,
    incomingInfluence,
  };
}

/** Updates one speed-graph handle while preserving the opposite temporal handle. */
export function easingFromGraphSpeedHandle(
  start: Pick<Keyframe, "time" | "value" | "easing">,
  end: Pick<Keyframe, "time" | "value">,
  handle: "out" | "in",
  influence: number,
  speed: number,
  baseSpeedOverride?: number,
): [number, number, number, number] {
  const easing = [...(start.easing ?? [0.42, 0, 0.58, 1])] as [number, number, number, number];
  const duration = Math.max(Number.EPSILON, end.time - start.time);
  const baseSpeed =
    baseSpeedOverride === undefined
      ? Math.abs((end.value - start.value) / duration)
      : finiteSpeed(baseSpeedOverride);
  if (baseSpeed <= Number.EPSILON) return easing;
  const safeInfluence = boundedInfluence(influence);
  const normalizedSlope = finiteSpeed(speed) / baseSpeed;
  if (handle === "out") {
    easing[0] = safeInfluence;
    easing[1] = Math.min(16, normalizedSlope * safeInfluence);
  } else {
    easing[2] = 1 - safeInfluence;
    easing[3] = Math.max(-15, 1 - normalizedSlope * safeInfluence);
  }
  return easing;
}

export function graphTrackSegmentBaseSpeed(
  track: GraphTrack,
  start: Pick<Keyframe, "time" | "value">,
  end: Pick<Keyframe, "time" | "value">,
): number {
  const duration = Math.max(Number.EPSILON, end.time - start.time);
  if (!track.spatialProperties) return Math.abs((end.value - start.value) / duration);
  return (
    Math.hypot(
      ...track.spatialProperties.map(
        (property) =>
          evaluateAnimatable(property, end.time) - evaluateAnimatable(property, start.time),
      ),
    ) / duration
  );
}

export function graphTrackSegmentKeyframes(
  track: GraphTrack,
  startTime: number,
  endTime: number,
): Array<{ path: PropertyPath; keyframe: Keyframe }> {
  if (!track.spatialProperties || !track.spatialPaths)
    return track.property.keyframes
      .filter((keyframe) => keyframe.time === startTime)
      .map((keyframe) => ({ path: track.path, keyframe }));
  return track.spatialProperties.flatMap((property, index) => {
    if (property.mode !== "animated") return [];
    const start = property.keyframes.find((keyframe) => keyframe.time === startTime);
    const end = property.keyframes.find((keyframe) => keyframe.time === endTime);
    const path = track.spatialPaths?.[index];
    return start && end && path ? [{ path, keyframe: start }] : [];
  });
}

export function graphTrackKeyframesAtTime(
  track: GraphTrack,
  time: number,
): Array<{ path: PropertyPath; keyframe: Keyframe }> {
  if (!track.spatialProperties || !track.spatialPaths)
    return track.property.keyframes
      .filter((keyframe) => Math.abs(keyframe.time - time) <= 0.000_001)
      .map((keyframe) => ({ path: track.path, keyframe }));
  return track.spatialProperties.flatMap((property, index) => {
    if (property.mode !== "animated") return [];
    const keyframe = property.keyframes.find(
      (candidate) => Math.abs(candidate.time - time) <= 0.000_001,
    );
    const path = track.spatialPaths?.[index];
    return keyframe && path ? [{ path, keyframe }] : [];
  });
}

/** Builds the segment-owned temporal handles affected by AE Easy Ease In, Out, or Both. */
export function easeGraphTrack(
  track: Pick<GraphTrack, "property">,
  selectedIds: ReadonlySet<string>,
  mode: GraphEaseMode,
): GraphEaseUpdate[] {
  const updates = new Map<string, GraphEaseUpdate>();
  const updateHandle = (keyframe: Keyframe, handle: "in" | "out") => {
    const current = updates.get(keyframe.id) ?? {
      keyframe,
      easing: [...(keyframe.easing ?? [1 / 3, 0, 2 / 3, 1])] as [number, number, number, number],
    };
    if (handle === "out") {
      current.easing[0] = 1 / 3;
      current.easing[1] = 0;
    } else {
      current.easing[2] = 2 / 3;
      current.easing[3] = 1;
    }
    updates.set(keyframe.id, current);
  };
  for (let index = 0; index < track.property.keyframes.length; index += 1) {
    const keyframe = track.property.keyframes[index];
    if (!selectedIds.has(keyframe.id)) continue;
    if ((mode === "both" || mode === "out") && index < track.property.keyframes.length - 1)
      updateHandle(keyframe, "out");
    if ((mode === "both" || mode === "in") && index > 0)
      updateHandle(track.property.keyframes[index - 1], "in");
  }
  return [...updates.values()];
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

function boundedInfluence(value: number): number {
  return Math.min(0.999, Math.max(0.001, Number.isFinite(value) ? value : 0.3333));
}

function finiteSpeed(value: number): number {
  return Number.isFinite(value) ? Math.min(1_000_000_000, Math.max(0, value)) : 0;
}
