import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type ProjectContextMenuActions, projectContextMenuItems } from "./ProjectContextMenu";

function actions(target: ProjectContextMenuActions["target"]): ProjectContextMenuActions {
  return {
    addSourceToComposition: vi.fn(),
    canAddSourceToComposition: true,
    canDelete: true,
    canDuplicate: true,
    canRelink: true,
    canRename: true,
    canRevealInComposition: true,
    createComposition: vi.fn(),
    createFolder: vi.fn(),
    deleteTarget: vi.fn(),
    deleteUnavailableReason: "Required item",
    duplicateTarget: vi.fn(),
    importAsset: vi.fn(),
    moveDestinations: [{ label: "Assets" }, { id: "folder-1", label: "Folder 1" }],
    moveTarget: vi.fn(),
    onClose: vi.fn(),
    openComposition: vi.fn(),
    relinkSource: vi.fn(),
    renameTarget: vi.fn(),
    revealInComposition: vi.fn(),
    target,
    x: 10,
    y: 20,
  };
}

describe("projectContextMenuItems", () => {
  it("offers project creation and every supported importer for empty space", () => {
    const value = actions({ kind: "empty" });
    const items = projectContextMenuItems(value, createTranslator("en-US"));
    expect(items.map((item) => item.id)).toEqual(["new-composition", "new-folder", "import"]);
    const importMenu = items.find((item) => item.id === "import");
    expect(importMenu?.kind === "submenu" && importMenu.items.map((item) => item.id)).toEqual([
      "import-image",
      "import-svg",
      "import-psd",
      "import-imageSequence",
      "import-video",
      "import-audio",
    ]);
  });

  it("routes composition actions and preserves destination identity", () => {
    const value = actions({ id: "comp-1", kind: "composition", name: "Comp" });
    const items = projectContextMenuItems(value, createTranslator("en-US"));
    for (const id of ["open-composition", "rename", "duplicate", "delete"]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    const move = items.find((item) => item.id === "move-to");
    if (move?.kind === "submenu" && move.items[1]?.kind === "command") move.items[1].onSelect();
    expect(value.openComposition).toHaveBeenCalledOnce();
    expect(value.renameTarget).toHaveBeenCalledOnce();
    expect(value.duplicateTarget).toHaveBeenCalledOnce();
    expect(value.deleteTarget).toHaveBeenCalledOnce();
    expect(value.moveTarget).toHaveBeenCalledWith("folder-1");
  });

  it("exposes selection-aware source commands with explicit disabled reasons", () => {
    const value = {
      ...actions({ id: "source-1", kind: "source" as const, name: "Image" }),
      canAddSourceToComposition: false,
      canDelete: false,
      canRelink: false,
      canRevealInComposition: false,
    };
    const items = projectContextMenuItems(value, createTranslator("en-US"));
    expect(items.find((item) => item.id === "add-to-composition")).toMatchObject({
      disabled: true,
      disabledReason: "No active composition",
    });
    expect(items.find((item) => item.id === "relink")).toMatchObject({ disabled: true });
    expect(items.find((item) => item.id === "delete")).toMatchObject({
      disabled: true,
      disabledReason: "Required item",
    });
  });

  it("combines folder creation and edit actions without empty submenus", () => {
    const value = {
      ...actions({ id: "folder-1", kind: "folder" as const, name: "Folder" }),
      moveDestinations: [],
    };
    const items = projectContextMenuItems(value, createTranslator("en-US"));
    expect(items.find((item) => item.id === "new-folder")).toBeDefined();
    expect(items.find((item) => item.id === "move-to")).toMatchObject({ disabled: true });
    expect(items.find((item) => item.id === "duplicate")).toBeUndefined();
  });
});
