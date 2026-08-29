import { describe, expect, it, vi } from "vitest";
import { normalizeSeparators, resolveContextMenu } from "./context-menu-model";

describe("context menu model", () => {
  it("resolves predicates and selection-aware actions without retaining context", () => {
    const rename = vi.fn();
    const items = resolveContextMenu(
      [
        { id: "leading", kind: "separator" },
        {
          id: "rename",
          kind: "command",
          label: "Rename",
          disabled: (context: { locked: boolean }) => context.locked,
          disabledReason: (context) => (context.locked ? "Layer is locked" : undefined),
          onSelect: rename,
        },
        {
          id: "hidden",
          kind: "command",
          label: "Hidden",
          when: () => false,
          onSelect: vi.fn(),
        },
        { id: "trailing", kind: "separator" },
      ],
      { locked: false },
    );
    expect(items.map((item) => item.id)).toEqual(["rename"]);
    const item = items[0];
    if (item?.kind !== "command") throw new Error("Expected command");
    item.onSelect();
    expect(rename).toHaveBeenCalledWith({ locked: false });
    const lockedItems = resolveContextMenu(
      [
        {
          id: "rename",
          kind: "command",
          label: "Rename",
          disabled: (context: { locked: boolean }) => context.locked,
          disabledReason: (context) => (context.locked ? "Layer is locked" : undefined),
          onSelect: rename,
        },
      ],
      { locked: true },
    );
    expect(lockedItems[0]).toMatchObject({ disabled: true, disabledReason: "Layer is locked" });
  });

  it("normalizes nested groups and computes checked and disabled state", () => {
    const items = resolveContextMenu(
      [
        {
          id: "view",
          kind: "submenu",
          label: "View",
          items: [
            { id: "empty", kind: "separator" },
            {
              id: "guides",
              kind: "checkbox",
              label: "Guides",
              checked: (context: { guides: boolean }) => context.guides,
              disabled: false,
              onSelect: vi.fn(),
            },
          ],
        },
      ],
      { guides: true },
    );
    const submenu = items[0];
    if (submenu?.kind !== "submenu") throw new Error("Expected submenu");
    expect(submenu.items).toHaveLength(1);
    expect(submenu.items[0]).toMatchObject({ id: "guides", checked: true });
  });

  it("removes duplicate and boundary separators", () => {
    expect(
      normalizeSeparators([
        { id: "a", kind: "separator" },
        { id: "one", kind: "command", label: "One", onSelect: vi.fn() },
        { id: "b", kind: "separator" },
        { id: "c", kind: "separator" },
      ]).map((item) => item.id),
    ).toEqual(["one"]);
  });
});
