import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_LAYOUT } from "./default-layout";
import type { WorkspaceStorage } from "./layout-storage";
import {
  createWorkspaceCatalog,
  deleteWorkspace,
  loadWorkspaceCatalog,
  renameWorkspace,
  saveWorkspaceAs,
  saveWorkspaceCatalog,
  selectWorkspace,
  uniqueWorkspaceName,
  WORKSPACE_CATALOG_STORAGE_KEY,
  workspaceById,
} from "./named-workspaces";

function memoryStorage(
  initial?: string,
): WorkspaceStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial) values.set(WORKSPACE_CATALOG_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("named workspaces", () => {
  it("provides immutable built-ins and selects them without rebuilding the catalog", () => {
    const catalog = createWorkspaceCatalog();
    expect(catalog.workspaces.map((workspace) => workspace.id)).toEqual([
      "default",
      "animation",
      "minimal",
    ]);
    const selected = selectWorkspace(catalog, "animation");
    expect(selected.currentWorkspaceId).toBe("animation");
    expect(selectWorkspace(selected, "animation")).toBe(selected);
    expect(renameWorkspace(selected, "animation", "Motion")).toBe(selected);
    expect(deleteWorkspace(selected, "animation")).toBe(selected);
  });

  it("normalizes and de-duplicates Save As and Rename names deterministically", () => {
    const catalog = createWorkspaceCatalog();
    expect(uniqueWorkspaceName(catalog, " default ")).toBe("default 2");
    const saved = saveWorkspaceAs(catalog, "Default", DEFAULT_WORKSPACE_LAYOUT);
    const custom = workspaceById(saved, saved.currentWorkspaceId);
    expect(custom).toMatchObject({ name: "Default 2", builtIn: false });
    const renamed = renameWorkspace(saved, custom?.id ?? "", " Animation ");
    expect(workspaceById(renamed, renamed.currentWorkspaceId)?.name).toBe("Animation 2");
  });

  it("deletes custom workspaces and returns the current selection to Default", () => {
    const saved = saveWorkspaceAs(createWorkspaceCatalog(), "Review", DEFAULT_WORKSPACE_LAYOUT);
    const deleted = deleteWorkspace(saved, saved.currentWorkspaceId);
    expect(deleted.currentWorkspaceId).toBe("default");
    expect(deleted.workspaces).toHaveLength(3);
  });

  it("round-trips custom snapshots and restores the current named workspace", () => {
    const storage = memoryStorage();
    const saved = saveWorkspaceAs(createWorkspaceCatalog(), "Review", DEFAULT_WORKSPACE_LAYOUT);
    expect(saveWorkspaceCatalog(saved, storage)).toBe(true);
    expect(loadWorkspaceCatalog(storage)).toEqual(saved);
  });

  it("falls back atomically for malformed, duplicate, and future catalog data", () => {
    const fallback = createWorkspaceCatalog();
    expect(loadWorkspaceCatalog(memoryStorage("{"))).toEqual(fallback);
    expect(
      loadWorkspaceCatalog(
        memoryStorage(JSON.stringify({ schemaVersion: 999, customWorkspaces: [] })),
      ),
    ).toEqual(fallback);
    expect(
      loadWorkspaceCatalog(
        memoryStorage(
          JSON.stringify({
            schemaVersion: 1,
            currentWorkspaceId: "default",
            customWorkspaces: [{ id: "default", name: "Copy", layout: {} }],
          }),
        ),
      ),
    ).toEqual(fallback);
  });
});
