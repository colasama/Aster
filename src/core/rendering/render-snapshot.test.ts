import { describe, expect, it } from "vitest";
import { createInitialState, editorReducer } from "../../state/editor-store";
import {
  copyRenderSnapshotIdentity,
  editorRenderSnapshotIdentity,
  validateRenderSnapshotIdentity,
} from "./render-snapshot";

describe("caller-owned render snapshots", () => {
  it("copies a bounded identity without aliasing its caller", () => {
    const input = { snapshotScope: "editor:中文🎞", projectRevision: 7 };
    const snapshot = copyRenderSnapshotIdentity(input);
    input.snapshotScope = "other";
    input.projectRevision = 8;
    expect(snapshot).toEqual({ snapshotScope: "editor:中文🎞", projectRevision: 7 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() =>
      validateRenderSnapshotIdentity({ snapshotScope: "a".repeat(256), projectRevision: 0 }),
    ).not.toThrow();
  });

  it.each(["", "a\0b", "\ud800", "\udfff", "a".repeat(257), "🎞".repeat(65)])(
    "rejects an invalid scope %j",
    (snapshotScope) => {
      expect(() => copyRenderSnapshotIdentity({ snapshotScope, projectRevision: 0 })).toThrow(
        "scope",
      );
    },
  );

  it.each([-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid revision %s",
    (projectRevision) => {
      expect(() =>
        copyRenderSnapshotIdentity({ snapshotScope: "loaded", projectRevision }),
      ).toThrow("revision");
    },
  );

  it("uses actual editor edits and load lineage across undo, redo and a same-ID reload", () => {
    const initial = createInitialState();
    const snapshot = (state: typeof initial) =>
      editorRenderSnapshotIdentity("editor:session", state.loadRevision, state.projectRevision);
    const edited = editorReducer(initial, {
      type: "operation",
      operations: [
        {
          type: "renameLayer",
          layerId: initial.project.compositions[0].layers[0].id,
          name: "Changed",
        },
      ],
    });
    const undone = editorReducer(edited, { type: "undo" });
    const redone = editorReducer(undone, { type: "redo" });
    expect(
      [initial, edited, undone, redone].map((state) => snapshot(state).projectRevision),
    ).toEqual([0, 1, 2, 3]);
    const reloaded = editorReducer(redone, {
      type: "loadProject",
      project: structuredClone(redone.project),
    });
    expect(reloaded.project.id).toBe(redone.project.id);
    expect(snapshot(reloaded).snapshotScope).not.toBe(snapshot(redone).snapshotScope);
    expect(snapshot(reloaded).projectRevision).toBe(0);
  });
});
