import { describe, expect, it } from "vitest";
import {
  copyKeyframes,
  pasteKeyframes,
  removeKeyframes,
} from "../../core/animation/keyframe-editing";
import { applyOperations } from "../../core/editing/operations";
import { activeComposition } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { createInitialState, editorReducer } from "../../state/editor-store";
import {
  constrainGraphPasteOperations,
  deduplicateGraphEntries,
  expandSpatialGraphEntries,
  graphEaseOperations,
  graphEditableKeyframe,
  graphInterpolationOperations,
  graphTrackOwnsEntry,
  graphUpdateOperations,
} from "./editing";
import { collectAnimatedGraphTracks } from "./model";

describe("graph editor keyframe operations", () => {
  it("replaces an effect keyframe with the same identity in one undo transaction", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    const effect = createEffect("gaussian-blur");
    const keyframe = {
      id: "effect-radius-key",
      time: 1,
      value: 18,
      interpolation: "bezier" as const,
      easing: [0.2, 0.1, 0.8, 0.9] as [number, number, number, number],
    };
    effect.parameterKeyframes = { radius: [keyframe] };
    layer.effects.push(effect);
    const track = collectAnimatedGraphTracks(layer).find(
      (candidate) => candidate.source === "effect" && candidate.parameter === "radius",
    );
    expect(track).toBeDefined();
    if (!track) return;
    const entry = graphEditableKeyframe(layer.id, track, keyframe);
    const updated = {
      ...keyframe,
      time: 2,
      value: 42,
      easing: [0.3, 0, 0.7, 1] as [number, number, number, number],
    };

    const committed = editorReducer(initial, {
      type: "operation",
      operations: graphUpdateOperations(entry, updated),
    });
    const committedTrack = activeComposition(committed.project).layers[0].effects.find(
      (candidate) => candidate.id === effect.id,
    )?.parameterKeyframes?.radius;
    expect(committed.history.past).toHaveLength(1);
    expect(committedTrack).toEqual([updated]);
    expect(committedTrack?.[0]?.id).toBe(keyframe.id);

    const undone = editorReducer(committed, { type: "undo" });
    expect(
      activeComposition(undone.project).layers[0].effects.find(
        (candidate) => candidate.id === effect.id,
      )?.parameterKeyframes?.radius,
    ).toEqual([keyframe]);
  });

  it("keeps transform and effect ownership distinct while deduplicating spatial entries", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    layer.transform.position[0] = {
      mode: "animated",
      keyframes: [{ id: "shared", time: 0, value: 0, interpolation: "linear" }],
    };
    const effect = createEffect("gaussian-blur");
    effect.parameterKeyframes = {
      radius: [{ id: "shared", time: 0, value: 18, interpolation: "linear" }],
    };
    layer.effects.push(effect);
    const tracks = collectAnimatedGraphTracks(layer);
    const transform = tracks.find((track) => track.source === "transform");
    const effectTrack = tracks.find((track) => track.source === "effect");
    expect(transform).toBeDefined();
    expect(effectTrack).toBeDefined();
    if (!transform || !effectTrack) return;
    const transformEntry = graphEditableKeyframe(
      layer.id,
      transform,
      transform.property.keyframes[0],
    );
    const effectEntry = graphEditableKeyframe(
      layer.id,
      effectTrack,
      effectTrack.property.keyframes[0],
    );

    expect(graphTrackOwnsEntry(transform, transformEntry)).toBe(true);
    expect(graphTrackOwnsEntry(transform, effectEntry)).toBe(false);
    expect(deduplicateGraphEntries([transformEntry, transformEntry, effectEntry])).toEqual([
      transformEntry,
      effectEntry,
    ]);
  });

  it("routes effect copy, paste and delete through the track-aware operation domain", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    const effect = createEffect("gaussian-blur");
    const keyframe = { id: "radius-copy", time: 1, value: 24, interpolation: "linear" as const };
    effect.parameterKeyframes = { radius: [keyframe] };
    layer.effects.push(effect);
    const track = collectAnimatedGraphTracks(layer).find(
      (candidate) => candidate.source === "effect" && candidate.parameter === "radius",
    );
    expect(track).toBeDefined();
    if (!track) return;
    const entry = graphEditableKeyframe(layer.id, track, keyframe);
    const clipboard = copyKeyframes([entry]);
    expect(clipboard).toBeDefined();
    if (!clipboard) return;
    const pasted = pasteKeyframes(clipboard, 3, 10);
    const withPaste = applyOperations(initial.project, pasted.operations);
    const pastedTrack = activeComposition(withPaste).layers[0].effects.find(
      (candidate) => candidate.id === effect.id,
    )?.parameterKeyframes?.radius;
    expect(pasted.operations).toMatchObject([
      { type: "addEffectParameterKeyframe", effectId: effect.id, parameter: "radius" },
    ]);
    expect(pastedTrack?.map(({ id, time }) => ({ id, time }))).toEqual([
      { id: keyframe.id, time: 1 },
      { id: pasted.selectedIds[0], time: 3 },
    ]);

    const withoutOriginal = applyOperations(withPaste, removeKeyframes([entry]));
    expect(
      activeComposition(withoutOriginal)
        .layers[0].effects.find((candidate) => candidate.id === effect.id)
        ?.parameterKeyframes?.radius?.map(({ id }) => id),
    ).toEqual([pasted.selectedIds[0]]);
  });

  it("normalizes pasted discrete effect keys to bounded Hold values", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    const effect = createEffect("radial-blur");
    const keyframe = {
      id: "mode-source",
      time: 0,
      value: 0.7,
      interpolation: "bezier" as const,
      easing: [0.2, 0, 0.8, 1] as [number, number, number, number],
    };
    effect.parameterKeyframes = { mode: [keyframe] };
    layer.effects.push(effect);
    const track = collectAnimatedGraphTracks(layer).find(
      (candidate) => candidate.source === "effect" && candidate.parameter === "mode",
    );
    expect(track).toBeDefined();
    if (!track) return;
    const clipboard = copyKeyframes([graphEditableKeyframe(layer.id, track, keyframe)]);
    expect(clipboard).toBeDefined();
    if (!clipboard) return;
    const pasted = pasteKeyframes(clipboard, 2, 10);
    const operations = constrainGraphPasteOperations(pasted.operations, [
      { layerId: layer.id, track },
    ]);
    expect(operations).toMatchObject([
      {
        type: "addEffectParameterKeyframe",
        keyframe: { value: 1, interpolation: "step", easing: undefined },
      },
    ]);
  });

  it("treats a collapsed Position speed key as one atomic spatial property", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    layer.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "x-start", time: 0, value: 0, interpolation: "linear" },
        { id: "x-end", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    layer.transform.position[1] = {
      mode: "animated",
      keyframes: [
        { id: "y-start", time: 0, value: 0, interpolation: "linear" },
        { id: "y-end", time: 1, value: 50, interpolation: "linear" },
      ],
    };
    const tracks = collectAnimatedGraphTracks(layer);
    const primary = tracks.find(
      (track) => track.source === "transform" && track.path === "position.0",
    );
    expect(primary).toBeDefined();
    if (!primary) return;
    const owners = tracks.map((track) => ({ layerId: layer.id, track }));
    const entries = expandSpatialGraphEntries(
      [graphEditableKeyframe(layer.id, primary, primary.property.keyframes[0])],
      owners,
      "auto",
    );
    expect(entries.flatMap((entry) => (entry.source === "transform" ? [entry.path] : []))).toEqual([
      "position.0",
      "position.1",
    ]);

    const interpolation = editorReducer(initial, {
      type: "operation",
      operations: graphInterpolationOperations(entries, owners, "step"),
    });
    expect(interpolation.history.past).toHaveLength(1);
    expect(
      activeComposition(interpolation.project)
        .layers[0].transform.position.slice(0, 2)
        .map((property) =>
          property.mode === "animated" ? property.keyframes[0].interpolation : "",
        ),
    ).toEqual(["step", "step"]);

    const eased = editorReducer(initial, {
      type: "operation",
      operations: graphEaseOperations(entries, owners, "both"),
    });
    expect(eased.history.past).toHaveLength(1);
    expect(
      activeComposition(eased.project)
        .layers[0].transform.position.slice(0, 2)
        .map((property) =>
          property.mode === "animated" ? property.keyframes[0].interpolation : "",
        ),
    ).toEqual(["bezier", "bezier"]);

    const clipboard = copyKeyframes(entries);
    expect(clipboard).toBeDefined();
    if (!clipboard) return;
    const pasted = pasteKeyframes(clipboard, 2, 10);
    const withPaste = editorReducer(initial, { type: "operation", operations: pasted.operations });
    expect(withPaste.history.past).toHaveLength(1);
    expect(pasted.operations).toHaveLength(2);

    const deleted = editorReducer(initial, {
      type: "operation",
      operations: removeKeyframes(entries),
    });
    expect(deleted.history.past).toHaveLength(1);
    expect(
      activeComposition(deleted.project)
        .layers[0].transform.position.slice(0, 2)
        .map((property) => property.mode),
    ).toEqual(["animated", "animated"]);
    expect(
      activeComposition(deleted.project)
        .layers[0].transform.position.slice(0, 2)
        .map((property) =>
          property.mode === "animated" ? property.keyframes.map(({ id }) => id) : [],
        ),
    ).toEqual([["x-end"], ["y-end"]]);
  });
});
