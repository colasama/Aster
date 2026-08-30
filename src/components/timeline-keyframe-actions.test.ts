import { describe, expect, it } from "vitest";
import { collectEditableKeyframes } from "../core/keyframe-editing";
import { activeComposition } from "../core/project";
import { createEffect } from "../effects/registry";
import { createInitialState, editorReducer } from "../state/editor-store";
import {
  canInterpolateTimelineKeyframes,
  timelineKeyframeInterpolationOperations,
} from "./timeline-keyframe-actions";

describe("timeline keyframe context actions", () => {
  it("updates effect interpolation with the same ID in one undoable transaction", () => {
    const initial = createInitialState();
    const composition = activeComposition(initial.project);
    const layer = composition.layers[0];
    const effect = createEffect("gaussian-blur");
    effect.parameterKeyframes = {
      radius: [{ id: "effect-key", time: 1, value: 24, interpolation: "linear" }],
    };
    layer.effects.push(effect);
    const entries = collectEditableKeyframes(composition).filter(
      (entry) => entry.source === "effect" && entry.effectId === effect.id,
    );

    expect(canInterpolateTimelineKeyframes(composition, entries)).toBe(true);
    const operations = timelineKeyframeInterpolationOperations(composition, entries, "bezier");
    expect(operations).toMatchObject([
      {
        type: "removeEffectParameterKeyframe",
        keyframeId: "effect-key",
      },
      {
        type: "addEffectParameterKeyframe",
        keyframe: { id: "effect-key", interpolation: "bezier" },
      },
    ]);

    const committed = editorReducer(initial, { type: "operation", operations });
    expect(committed.history.past).toHaveLength(1);
    expect(
      activeComposition(committed.project).layers[0].effects.find(
        (candidate) => candidate.id === effect.id,
      )?.parameterKeyframes?.radius,
    ).toMatchObject([{ id: "effect-key", interpolation: "bezier" }]);
    const undone = editorReducer(committed, { type: "undo" });
    expect(
      activeComposition(undone.project).layers[0].effects.find(
        (candidate) => candidate.id === effect.id,
      )?.parameterKeyframes?.radius,
    ).toMatchObject([{ id: "effect-key", interpolation: "linear" }]);
  });
});
