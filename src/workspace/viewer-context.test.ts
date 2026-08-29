import { describe, expect, it } from "vitest";
import { createDemoProject } from "../core/project";
import { resolveWorkspaceViewerComposition } from "./viewer-context";

describe("workspace viewer composition context", () => {
  it("keeps a locked viewer on its prior composition without mutating project active context", () => {
    const project = createDemoProject();
    const first = project.compositions[0];
    if (!first) throw new Error("fixture composition missing");
    const second = structuredClone(first);
    second.id = "composition-2";
    second.name = "Second";
    project.compositions.push(second);
    project.activeCompositionId = second.id;

    const resolved = resolveWorkspaceViewerComposition(project, {
      id: "viewport",
      sourcePanelId: "viewport",
      viewerType: "composition",
      locked: true,
      contextId: first.id,
    });
    expect(resolved).toEqual({ composition: first, readOnly: true });
    expect(project.activeCompositionId).toBe(second.id);
  });

  it("follows the active composition when unlocked or when a stale lock target disappears", () => {
    const project = createDemoProject();
    const active = project.compositions[0];
    expect(resolveWorkspaceViewerComposition(project, null)).toEqual({
      composition: active,
      readOnly: false,
    });
    expect(
      resolveWorkspaceViewerComposition(project, {
        id: "viewport",
        sourcePanelId: "viewport",
        viewerType: "composition",
        locked: true,
        contextId: "missing",
      }),
    ).toEqual({ composition: active, readOnly: false });
  });
});
