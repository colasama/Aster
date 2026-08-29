import type { EditableKeyframe } from "../../core/keyframe-editing";
import type { Operation } from "../../core/operations";
import type { Id, Keyframe } from "../../core/types";
import {
  constrainGraphTrackValue,
  easeGraphTrack,
  type GraphEaseMode,
  type GraphKeyframeTarget,
  type GraphTrack,
  type GraphType,
  graphTrackInterpolation,
  graphTrackKeyframesAtTime,
  resolveGraphType,
} from "./model";

export interface GraphTrackOwner {
  layerId: Id;
  track: GraphTrack;
}

export function graphEditableKeyframe(
  layerId: Id,
  track: GraphTrack,
  keyframe: Keyframe,
): EditableKeyframe {
  return track.source === "transform"
    ? { source: "transform", layerId, path: track.path, keyframe }
    : {
        source: "effect",
        layerId,
        effectId: track.effectId,
        parameter: track.parameter,
        keyframe,
      };
}

export function graphTargetEditableKeyframe(
  layerId: Id,
  target: GraphKeyframeTarget,
): EditableKeyframe {
  return target.source === "transform"
    ? { source: "transform", layerId, path: target.path, keyframe: target.keyframe }
    : {
        source: "effect",
        layerId,
        effectId: target.effectId,
        parameter: target.parameter,
        keyframe: target.keyframe,
      };
}

export function graphTrackOwnsEntry(track: GraphTrack, entry: EditableKeyframe): boolean {
  return track.source === "transform"
    ? entry.source === "transform" && entry.path === track.path
    : entry.source === "effect" &&
        entry.effectId === track.effectId &&
        entry.parameter === track.parameter;
}

/**
 * Produces an exact keyframe replacement. Effects do not yet expose a dedicated update command,
 * so their remove/add pair intentionally shares one dispatch and retains the stable keyframe ID.
 */
export function graphUpdateOperations(entry: EditableKeyframe, keyframe: Keyframe): Operation[] {
  if (entry.source === "transform")
    return [
      {
        type: "updateKeyframe",
        layerId: entry.layerId,
        path: entry.path,
        keyframeId: entry.keyframe.id,
        time: keyframe.time,
        value: keyframe.value,
        interpolation: keyframe.interpolation,
        easing: keyframe.easing,
        spatialIn: keyframe.spatialIn,
        spatialOut: keyframe.spatialOut,
      },
    ];
  return [
    {
      type: "removeEffectParameterKeyframe",
      layerId: entry.layerId,
      effectId: entry.effectId,
      parameter: entry.parameter,
      keyframeId: entry.keyframe.id,
    },
    {
      type: "addEffectParameterKeyframe",
      layerId: entry.layerId,
      effectId: entry.effectId,
      parameter: entry.parameter,
      keyframe,
    },
  ];
}

export function deduplicateGraphEntries(entries: readonly EditableKeyframe[]): EditableKeyframe[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const owner =
      entry.source === "transform"
        ? `transform:${entry.path}`
        : `effect:${entry.effectId}:${entry.parameter}`;
    const key = `${entry.layerId}:${owner}:${entry.keyframe.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function constrainGraphPasteOperations(
  operations: readonly Operation[],
  tracks: readonly GraphTrackOwner[],
): Operation[] {
  return operations.map((operation) => {
    if (operation.type !== "addEffectParameterKeyframe") return operation;
    const owner = tracks.find(
      ({ layerId, track }) =>
        layerId === operation.layerId &&
        track.source === "effect" &&
        track.effectId === operation.effectId &&
        track.parameter === operation.parameter,
    );
    if (!owner) return operation;
    const interpolation = graphTrackInterpolation(owner.track, operation.keyframe.interpolation);
    return {
      ...operation,
      keyframe: {
        ...operation.keyframe,
        value: constrainGraphTrackValue(owner.track, operation.keyframe.value),
        interpolation,
        easing: interpolation === "bezier" ? operation.keyframe.easing : undefined,
      },
    };
  });
}

export function expandSpatialGraphEntries(
  entries: readonly EditableKeyframe[],
  tracks: readonly GraphTrackOwner[],
  graphType: GraphType,
): EditableKeyframe[] {
  return deduplicateGraphEntries(
    entries.flatMap((entry) => {
      const owner = tracks.find(
        ({ layerId, track }) => layerId === entry.layerId && graphTrackOwnsEntry(track, entry),
      );
      if (!owner?.track.spatialProperties || resolveGraphType(graphType, owner.track) !== "speed")
        return [entry];
      return graphTrackKeyframesAtTime(owner.track, entry.keyframe.time).map((target) =>
        graphTargetEditableKeyframe(owner.layerId, target),
      );
    }),
  );
}

export function graphInterpolationOperations(
  entries: readonly EditableKeyframe[],
  tracks: readonly GraphTrackOwner[],
  interpolation: Keyframe["interpolation"],
  easing?: Keyframe["easing"],
): Operation[] {
  return entries.flatMap((entry) => {
    const owner = tracks.find(
      ({ layerId, track }) => layerId === entry.layerId && graphTrackOwnsEntry(track, entry),
    );
    if (!owner) return [];
    const nextInterpolation = graphTrackInterpolation(owner.track, interpolation);
    return graphUpdateOperations(entry, {
      ...entry.keyframe,
      interpolation: nextInterpolation,
      easing: nextInterpolation === "bezier" ? (easing ?? entry.keyframe.easing) : undefined,
    });
  });
}

export function graphEaseOperations(
  entries: readonly EditableKeyframe[],
  tracks: readonly GraphTrackOwner[],
  mode: GraphEaseMode,
): Operation[] {
  return tracks.flatMap(({ layerId, track }) => {
    if (track.discrete) return [];
    const selectedIds = new Set(
      entries
        .filter((entry) => entry.layerId === layerId && graphTrackOwnsEntry(track, entry))
        .map((entry) => entry.keyframe.id),
    );
    return easeGraphTrack(track, selectedIds, mode).flatMap(({ keyframe, easing }) =>
      graphUpdateOperations(graphEditableKeyframe(layerId, track, keyframe), {
        ...keyframe,
        interpolation: "bezier",
        easing,
      }),
    );
  });
}
