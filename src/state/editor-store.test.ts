import { describe, expect, it } from "vitest";
import { serializeProject, validateProjectDocument } from "../core/project-file";
import { createInitialState, editorReducer } from "./editor-store";

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
});
