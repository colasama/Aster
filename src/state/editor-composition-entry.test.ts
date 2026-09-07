import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { precomposeLayers } from "../core/precomposition";
import { activeComposition, createBlankProject } from "../core/project";
import { visibleLayersAtTime } from "../core/scene-evaluation";
import { createInitialState, editorReducer } from "./editor-store";

function lateShot() {
  const project = createBlankProject();
  const root = project.compositions[0];
  root.duration = 60;
  root.workArea = { start: 0, end: 60 };
  const layer = createLayerForComposition("shape", root, 45);
  layer.outPoint = 50;
  root.layers = [layer];
  const result = precomposeLayers(project, [layer.id]);
  if (!result) throw new Error("Precomposition missing");
  return {
    layer,
    compositionId: result.nestedCompositionId,
    state: {
      ...createInitialState(),
      project: result.project,
      currentTime: 1,
      seekRevision: 10,
      playing: true,
      selectedKeyframes: ["old-key"],
    },
  };
}

describe("composition entry time", () => {
  it.each(["navigation", "command"] as const)(
    "shows a late-starting shot immediately after %s activation",
    (entry) => {
      const { state, compositionId, layer } = lateShot();
      const opened = editorReducer(
        state,
        entry === "navigation"
          ? { type: "setActiveComposition", compositionId }
          : { type: "operation", operations: [{ type: "setActiveComposition", compositionId }] },
      );
      expect(opened.currentTime).toBe(45);
      expect(opened.playing).toBe(false);
      expect(opened.selectedKeyframes).toEqual([]);
      expect(opened.selection).toEqual([layer.id]);
      expect(opened.seekRevision).toBe(11);
      expect(visibleLayersAtTime(activeComposition(opened.project), opened.currentTime)).toEqual([
        layer,
      ]);
      expect(opened.history.past).toHaveLength(1);

      const undone = editorReducer(opened, { type: "undo" });
      expect(undone.currentTime).toBe(0);
      const redone = editorReducer(undone, { type: "redo" });
      expect(redone.currentTime).toBe(45);
      expect(redone.playing).toBe(false);
      expect(redone.selectedKeyframes).toEqual([]);
    },
  );

  it("loads a project saved with a late-starting child active at its first work-area frame", () => {
    const { state, compositionId, layer } = lateShot();
    const project = { ...state.project, activeCompositionId: compositionId };
    const loaded = editorReducer(state, { type: "loadProject", project, markSaved: true });
    expect(loaded.currentTime).toBe(45);
    expect(loaded.playing).toBe(false);
    expect(loaded.selectedKeyframes).toEqual([]);
    expect(loaded.selection).toEqual([layer.id]);
    expect(loaded.seekRevision).toBe(11);
    expect(loaded.history.past).toEqual([]);
  });

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 50, 51])(
    "falls back to zero for unavailable or out-of-range work-area start %s",
    (start) => {
      const { state, compositionId } = lateShot();
      const project = { ...state.project, activeCompositionId: compositionId };
      const composition = activeComposition(project);
      if (start === undefined) Reflect.deleteProperty(composition, "workArea");
      else composition.workArea.start = start;
      const loaded = editorReducer(state, { type: "loadProject", project });
      expect(loaded.currentTime).toBe(0);
    },
  );

  it("does not interrupt playback or reset selections for an ordinary document edit", () => {
    const { state } = lateShot();
    const edited = editorReducer(state, {
      type: "operation",
      operations: [
        {
          type: "renameLayer",
          layerId: state.project.compositions[0].layers[0].id,
          name: "Renamed shot",
        },
      ],
    });
    expect(edited.currentTime).toBe(state.currentTime);
    expect(edited.playing).toBe(true);
    expect(edited.selectedKeyframes).toEqual(["old-key"]);
    expect(edited.seekRevision).toBe(10);
  });
});
