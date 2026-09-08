import { type GraphSampleBuffer, sampleGraph } from "../../core/graph-sampling";
import type { PropertyPath } from "../../core/operations";
import { evaluateAnimatable, evaluateAnimatableSpeed } from "../../core/timeline";
import type { Animatable, Keyframe, Layer } from "../../core/types";
import type { PlainMessageKey } from "../../i18n/core";
import {
  collectTimelinePropertyGroups,
  type TimelinePropertyTrack,
  timelineTrackKeyframes,
} from "../timeline-property-tracks";

export type GraphType = "auto" | "value" | "speed";
export type ResolvedGraphType = Exclude<GraphType, "auto">;
type AnimatedProperty = Extract<Animatable, { mode: "animated" }>;

interface GraphTrackBase {
  id: string;
  color: string;
  step: number;
  unit: string;
  minimum?: number;
  maximum?: number;
  discrete?: boolean;
  quantizeValue?: boolean;
  property: AnimatedProperty;
  /** Unseparated spatial components used to produce one speed magnitude. */
  spatialProperties?: readonly Animatable[];
  spatialPaths?: readonly PropertyPath[];
  spatialPrimary?: boolean;
  speedLabelKey?: PlainMessageKey;
}

export interface TransformGraphTrack extends GraphTrackBase {
  source: "transform";
  path: PropertyPath;
  labelKey: PlainMessageKey;
  labelPrefix?: string;
  labelSuffix?: string;
}

export interface EffectGraphTrack extends GraphTrackBase {
  source: "effect";
  effectId: string;
  parameter: string;
  label: string;
}

export type GraphTrack = TransformGraphTrack | EffectGraphTrack;

export type GraphKeyframeTarget =
  | { source: "transform"; path: PropertyPath; keyframe: Keyframe }
  | {
      source: "effect";
      effectId: string;
      parameter: string;
      keyframe: Keyframe;
    };

export interface GraphKeyframePreview {
  trackId: string;
  keyframeId: string;
  time: number;
  value: number;
}

export interface GraphEasingPreview {
  trackId: string;
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

const SPATIAL_GROUPS: ReadonlyArray<{
  paths: readonly PropertyPath[];
  speedLabelKey: PlainMessageKey;
}> = [
  {
    paths: ["position.0", "position.1", "position.2"],
    speedLabelKey: "graph.track.positionSpeed",
  },
  {
    paths: ["anchor.0", "anchor.1", "anchor.2"],
    speedLabelKey: "graph.track.anchorSpeed",
  },
  {
    paths: ["camera.pointOfInterest.0", "camera.pointOfInterest.1", "camera.pointOfInterest.2"],
    speedLabelKey: "graph.track.pointOfInterestSpeed",
  },
];

export function collectAnimatedGraphTracks(layer: Layer | undefined): GraphTrack[] {
  if (!layer) return [];
  const groups = collectTimelinePropertyGroups(layer);
  const allTracks = groups.flatMap((group) => group.tracks);
  const result: GraphTrack[] = [];
  for (const group of groups) {
    for (const [index, track] of group.tracks.entries()) {
      const keyframes = timelineTrackKeyframes(track);
      if (!keyframes.length) continue;
      const base = {
        id: track.id,
        color: graphTrackColor(track.id, index),
        step: graphTrackStep(track),
        unit: graphTrackUnit(track),
        property: { mode: "animated" as const, keyframes },
      };
      if (track.source === "effect") {
        result.push({
          ...base,
          source: "effect",
          effectId: track.effectId,
          parameter: track.parameter,
          label: `${group.label} · ${track.definition.label}`,
          minimum: track.definition.min,
          maximum: track.definition.max,
          discrete: track.definition.kind === "toggle" || track.definition.kind === "choice",
          quantizeValue: true,
        });
        continue;
      }
      const spatial = SPATIAL_GROUPS.find((candidate) => candidate.paths.includes(track.path));
      const spatialTracks = track.spatialGroup
        ? allTracks.flatMap((candidate) =>
            candidate.source === "transform" && candidate.spatialGroup === track.spatialGroup
              ? [candidate]
              : [],
          )
        : spatial
          ? spatial.paths.flatMap((path) => {
              const candidate = allTracks.find(
                (entry) => entry.source === "transform" && entry.path === path,
              );
              return candidate?.source === "transform" ? [candidate] : [];
            })
          : [];
      const primaryPath = spatialTracks.find(
        (candidate) => timelineTrackKeyframes(candidate).length > 0,
      )?.path;
      result.push({
        ...base,
        source: "transform",
        path: track.path,
        labelKey: track.labelKey,
        labelPrefix: track.labelPrefix,
        labelSuffix: track.labelSuffix,
        minimum: track.min,
        maximum: track.max,
        ...(spatial || track.spatialGroup
          ? {
              spatialPaths: spatialTracks.map((candidate) => candidate.path),
              spatialProperties: spatialTracks.map((candidate) => candidate.property),
              spatialPrimary: track.path === primaryPath,
              speedLabelKey: track.spatialSpeedLabelKey ?? spatial?.speedLabelKey,
            }
          : {}),
      });
    }
  }
  return result;
}

function graphTrackStep(track: TimelinePropertyTrack): number {
  if (track.source === "transform") return track.step;
  const step = track.definition.step;
  if (step !== undefined && Number.isFinite(step) && step > 0) return step;
  return track.definition.kind === "toggle" || track.definition.kind === "choice" ? 1 : 0.1;
}

function graphTrackUnit(track: TimelinePropertyTrack): string {
  if (track.source === "transform") return track.unit;
  return (
    track.definition.unit ??
    (track.definition.kind === "angle" ? "°" : track.definition.kind === "percent" ? "%" : "")
  );
}

function graphTrackColor(id: string, index: number): string {
  let hash = 0;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return `hsl(${Math.abs(hash + index * 137) % 360} 72% 66%)`;
}

/** Hides duplicate component curves when an unseparated spatial property is shown as speed. */
export function graphTracksForType(tracks: readonly GraphTrack[], type: GraphType): GraphTrack[] {
  return tracks.filter(
    (track) =>
      !track.spatialProperties || resolveGraphType(type, track) === "value" || track.spatialPrimary,
  );
}

export function graphTrackLabelKey(
  track: GraphTrack,
  type: GraphType,
): PlainMessageKey | undefined {
  if (resolveGraphType(type, track) === "speed" && track.speedLabelKey) return track.speedLabelKey;
  return track.source === "transform" ? track.labelKey : undefined;
}

export function resolveGraphType(
  type: GraphType,
  track: Pick<GraphTrack, "spatialProperties">,
): ResolvedGraphType {
  if (type !== "auto") return type;
  return track.spatialProperties ? "speed" : "value";
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
  if (track.source !== "transform") return { ...track, property };
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

export function constrainGraphTrackValue(track: GraphTrack, value: number): number {
  if (!Number.isFinite(value)) return track.property.keyframes[0]?.value ?? 0;
  const minimum = track.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = track.maximum ?? Number.POSITIVE_INFINITY;
  const clamped = Math.max(minimum, Math.min(maximum, value));
  if (!track.quantizeValue || !Number.isFinite(track.step) || track.step <= 0) return clamped;
  const origin = Number.isFinite(minimum) ? minimum : 0;
  const quantized = origin + Math.round((clamped - origin) / track.step) * track.step;
  return Math.max(minimum, Math.min(maximum, Number(quantized.toPrecision(12))));
}

export function graphTrackInterpolation(
  track: GraphTrack,
  interpolation: Keyframe["interpolation"],
): Keyframe["interpolation"] {
  return track.discrete ? "step" : interpolation;
}

/**
 * Converts the temporal cubic stored on a segment into absolute speed and influence.
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
): GraphKeyframeTarget[] {
  if (!track.spatialProperties || !track.spatialPaths)
    return track.property.keyframes
      .filter((keyframe) => keyframe.time === startTime)
      .map((keyframe) => graphKeyframeTarget(track, keyframe));
  return track.spatialProperties.flatMap((property, index) => {
    if (property.mode !== "animated") return [];
    const start = property.keyframes.find((keyframe) => keyframe.time === startTime);
    const end = property.keyframes.find((keyframe) => keyframe.time === endTime);
    const path = track.spatialPaths?.[index];
    return start && end && path ? [{ source: "transform" as const, path, keyframe: start }] : [];
  });
}

export function graphTrackKeyframesAtTime(track: GraphTrack, time: number): GraphKeyframeTarget[] {
  if (!track.spatialProperties || !track.spatialPaths)
    return track.property.keyframes
      .filter((keyframe) => Math.abs(keyframe.time - time) <= 0.000_001)
      .map((keyframe) => graphKeyframeTarget(track, keyframe));
  return track.spatialProperties.flatMap((property, index) => {
    if (property.mode !== "animated") return [];
    const keyframe = property.keyframes.find(
      (candidate) => Math.abs(candidate.time - time) <= 0.000_001,
    );
    const path = track.spatialPaths?.[index];
    return keyframe && path ? [{ source: "transform" as const, path, keyframe }] : [];
  });
}

export function graphKeyframeTarget(track: GraphTrack, keyframe: Keyframe): GraphKeyframeTarget {
  return track.source === "transform"
    ? { source: "transform", path: track.path, keyframe }
    : {
        source: "effect",
        effectId: track.effectId,
        parameter: track.parameter,
        keyframe,
      };
}

/** Builds the segment-owned temporal handles affected by Easy Ease In, Out, or Both. */
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
