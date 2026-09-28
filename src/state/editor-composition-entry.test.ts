import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { precomposeLayers } from "../core/project/precomposition";
import { activeComposition, createBlankProject } from "../core/project/project";
import { visibleLayersAtTime } from "../core/scene/scene-evaluation";
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
      expect(opened.selection).toEqual([]);
      expect(opened.seekRevision).toBe(11);
      expect(visibleLayersAtTime(activeComposition(opened.project), opened.currentTime)).toEqual([
        layer,
      ]);
      // Opening a composition from the project or timeline is navigation, not an edit.
      expect(opened.history.past).toHaveLength(entry === "navigation" ? 0 : 1);
      if (entry === "navigation") return;

      const undone = editorReducer(opened, { type: "undo" });
      // Returning to the parent restores the playhead the user left there.
      expect(undone.currentTime).toBe(1);
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
    expect(loaded.selection).toEqual([]);
    expect(visibleLayersAtTime(activeComposition(loaded.project), loaded.currentTime)).toEqual([
      layer,
    ]);
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

  it("keeps a clean document clean and restores each composition's playhead and selection", () => {
    const { state, compositionId, layer } = lateShot();
    const rootId = state.project.activeCompositionId;
    const wrapperId = activeComposition(state.project).layers[0].id;
    const clean = { ...state, selection: [wrapperId], savedProjectRevision: state.projectRevision };
    const opened = editorReducer(clean, { type: "setActiveComposition", compositionId });
    expect(opened.savedProjectRevision).toBe(opened.projectRevision);
    const edited = editorReducer(editorReducer(opened, { type: "select", ids: [layer.id] }), {
      type: "setTime",
      time: 47,
    });
    const back = editorReducer(edited, { type: "setActiveComposition", compositionId: rootId });
    expect(back.currentTime).toBe(1);
    expect(back.selection).toEqual([wrapperId]);
    const again = editorReducer(back, { type: "setActiveComposition", compositionId });
    expect(again.currentTime).toBe(47);
    expect(again.selection).toEqual([layer.id]);
    expect(again.history.past).toEqual([]);
  });

  it("keeps a dirty document dirty while navigating between compositions", () => {
    const { state, compositionId } = lateShot();
    const dirty = { ...state, savedProjectRevision: null };
    const opened = editorReducer(dirty, { type: "setActiveComposition", compositionId });
    expect(opened.savedProjectRevision).toBeNull();
  });

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
