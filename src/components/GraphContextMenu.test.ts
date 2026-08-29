import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type GraphContextMenuActions, graphContextMenuItems } from "./GraphContextMenu";

describe("graphContextMenuItems", () => {
  it("builds nested graph and interpolation controls with actionable disabled reasons", () => {
    const actions: GraphContextMenuActions = {
      canEdit: false,
      canPaste: false,
      copy: vi.fn(),
      delete: vi.fn(),
      disabledReason: "Locked",
      easyEase: vi.fn(),
      fitAll: vi.fn(),
      fitSelection: vi.fn(),
      graphType: "value",
      hasClipboard: false,
      hasSelection: true,
      hasTracks: true,
      onClose: vi.fn(),
      paste: vi.fn(),
      setGraphType: vi.fn(),
      setInterpolation: vi.fn(),
      x: 0,
      y: 0,
    };
    const items = graphContextMenuItems(actions, createTranslator("en-US"));
    const interpolation = items.find((item) => item.id === "interpolation");
    expect(interpolation).toMatchObject({ disabled: true, disabledReason: "Locked" });
    expect(interpolation?.kind === "submenu" && interpolation.items).toHaveLength(3);
  });
});
