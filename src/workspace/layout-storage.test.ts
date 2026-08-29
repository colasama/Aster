import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_LAYOUT } from "./default-layout";
import { CURRENT_WORKSPACE_LAYOUT_VERSION } from "./layout-schema";
import {
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  type WorkspaceStorage,
} from "./layout-storage";

function memoryStorage(
  initial?: string,
): WorkspaceStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(WORKSPACE_LAYOUT_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("workspace layout storage", () => {
  it("persists a versioned document and restores it", () => {
    const storage = memoryStorage();
    expect(saveWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, storage)).toBe(true);
    const raw = JSON.parse(storage.values.get(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null");
    expect(raw.schemaVersion).toBe(CURRENT_WORKSPACE_LAYOUT_VERSION);
    expect(loadWorkspaceLayout({ root: null, floating: [], closedPanels: [] }, storage)).toEqual(
      DEFAULT_WORKSPACE_LAYOUT,
    );
  });

  it("falls back atomically for malformed JSON, schema data, and storage failures", () => {
    expect(loadWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, memoryStorage("{"))).toBe(
      DEFAULT_WORKSPACE_LAYOUT,
    );
    expect(
      loadWorkspaceLayout(
        DEFAULT_WORKSPACE_LAYOUT,
        memoryStorage(JSON.stringify({ schemaVersion: 999 })),
      ),
    ).toBe(DEFAULT_WORKSPACE_LAYOUT);
    const denied: WorkspaceStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, denied)).toBe(DEFAULT_WORKSPACE_LAYOUT);
    expect(saveWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, denied)).toBe(false);
  });
});
