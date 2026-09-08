import { describe, expect, it } from "vitest";
import { serializeProject, validateProjectDocument } from "../core/project/project-file";
import { createInitialState, editorReducer, isProjectDirty } from "./editor-store";

describe("agent editor transactions", () => {
  it("merges a multi-command workspace as one saveable undo transaction", () => {
    const initial = createInitialState();
    const layer = initial.project.compositions[0].layers[0];
    const committed = editorReducer(initial, {
      type: "operation",
      operations: [
        { type: "renameLayer", layerId: layer.id, name: "Agent result" },
        { type: "setProperty", layerId: layer.id, path: "opacity", value: 0.5 },
      ],
      metadata: { source: "ai", summary: "Rename and fade" },
    });
    expect(committed.history.past).toHaveLength(1);
    expect(committed.projectRevision).toBe(initial.projectRevision + 1);
    expect(committed.auditLog[committed.auditLog.length - 1]?.operationTypes).toEqual([
      "renameLayer",
      "setProperty",
    ]);
    expect(() =>
      validateProjectDocument(JSON.parse(serializeProject(committed.project))),
    ).not.toThrow();

    const undone = editorReducer(committed, { type: "undo" });
    expect(undone.project.compositions[0].layers[0].name).toBe(layer.name);
    expect(undone.project.compositions[0].layers[0].transform.opacity).toEqual(
      layer.transform.opacity,
    );
  });

  it("tracks primary saves independently from later edits and recovery snapshots", () => {
    const initial = createInitialState();
    expect(isProjectDirty(initial)).toBe(false);
    const layerId = initial.project.compositions[0].layers[0].id;
    const edited = editorReducer(initial, {
      type: "operation",
      operations: [{ type: "renameLayer", layerId, name: "Edited" }],
    });
    expect(isProjectDirty(edited)).toBe(true);

    const autosaved = editorReducer(edited, {
      type: "autosaveCompleted",
      projectId: edited.project.id,
      revision: edited.projectRevision,
      at: "2026-08-29T00:00:00.000Z",
    });
    expect(isProjectDirty(autosaved)).toBe(true);
    expect(autosaved.autosave.status).toBe("saved");

    const saved = editorReducer(autosaved, {
      type: "markSaved",
      projectId: autosaved.project.id,
      revision: autosaved.projectRevision,
    });
    expect(isProjectDirty(saved)).toBe(false);

    const editedAgain = editorReducer(saved, {
      type: "operation",
      operations: [{ type: "renameLayer", layerId, name: "Edited again" }],
    });
    const staleCompletion = editorReducer(editedAgain, {
      type: "markSaved",
      projectId: editedAgain.project.id,
      revision: saved.projectRevision,
    });
    expect(isProjectDirty(staleCompletion)).toBe(true);
  });

  it("marks disk-loaded projects clean and recovered projects dirty", () => {
    const initial = createInitialState();
    const disk = editorReducer(initial, {
      type: "loadProject",
      project: structuredClone(initial.project),
      markSaved: true,
    });
    const recovery = editorReducer(initial, {
      type: "loadProject",
      project: structuredClone(initial.project),
      markSaved: false,
    });
    expect(isProjectDirty(disk)).toBe(false);
    expect(isProjectDirty(recovery)).toBe(true);

    const staleAutosave = editorReducer(disk, {
      type: "autosaveCompleted",
      projectId: disk.project.id,
      revision: 4,
      at: "2026-08-29T00:00:00.000Z",
    });
    expect(staleAutosave.autosave.status).toBe("idle");
  });
});
