import type { EditableKeyframe } from "../core/keyframe-editing";
import type { Operation } from "../core/operations";
import type { Composition, Keyframe } from "../core/types";
import {
  type GraphTrackOwner,
  graphInterpolationOperations,
  graphTrackOwnsEntry,
} from "./graph-editor/editing";
import { collectAnimatedGraphTracks } from "./graph-editor/model";

export function canInterpolateTimelineKeyframes(
  composition: Composition,
  entries: readonly EditableKeyframe[],
): boolean {
  if (entries.length === 0) return false;
  const owners = graphTrackOwners(composition);
  return entries.every((entry) =>
    owners.some(
      ({ layerId, track }) => layerId === entry.layerId && graphTrackOwnsEntry(track, entry),
    ),
  );
}

/** Uses the Graph Editor's canonical constraints and same-ID effect replacement transaction. */
export function timelineKeyframeInterpolationOperations(
  composition: Composition,
  entries: readonly EditableKeyframe[],
  interpolation: Keyframe["interpolation"],
): Operation[] {
  return graphInterpolationOperations(entries, graphTrackOwners(composition), interpolation);
}

function graphTrackOwners(composition: Composition): GraphTrackOwner[] {
  return composition.layers.flatMap((layer) =>
    collectAnimatedGraphTracks(layer).map((track) => ({ layerId: layer.id, track })),
  );
}
