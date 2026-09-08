import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../../i18n/core";
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
      easyEaseIn: vi.fn(),
      easyEaseOut: vi.fn(),
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
    const graphType = items.find((item) => item.id === "graph-type");
    expect(graphType?.kind === "submenu" && graphType.items.map((item) => item.id)).toEqual([
      "graph-auto",
      "graph-value",
      "graph-speed",
    ]);
  });

  it("routes property-view and selected-key actions through their callbacks", () => {
    const callbacks = {
      copy: vi.fn(),
      delete: vi.fn(),
      easyEase: vi.fn(),
      easyEaseIn: vi.fn(),
      easyEaseOut: vi.fn(),
      fitAll: vi.fn(),
      fitSelection: vi.fn(),
      paste: vi.fn(),
      setGraphType: vi.fn(),
      setInterpolation: vi.fn(),
    };
    const items = graphContextMenuItems(
      {
        ...callbacks,
        canEdit: true,
        canPaste: true,
        disabledReason: "Locked",
        graphType: "auto",
        hasClipboard: true,
        hasSelection: true,
        hasTracks: true,
        onClose: vi.fn(),
        x: 0,
        y: 0,
      },
      createTranslator("en-US"),
    );
    const graphType = items.find((item) => item.id === "graph-type");
    const value =
      graphType?.kind === "submenu"
        ? graphType.items.find((item) => item.id === "graph-value")
        : undefined;
    if (value?.kind === "radio") value.onSelect();
    const interpolation = items.find((item) => item.id === "interpolation");
    const hold =
      interpolation?.kind === "submenu"
        ? interpolation.items.find((item) => item.id === "hold")
        : undefined;
    if (hold?.kind === "command") hold.onSelect();
    for (const id of [
      "fit-selection",
      "fit-all",
      "easy-ease",
      "easy-ease-in",
      "easy-ease-out",
      "copy",
      "paste",
      "delete",
    ]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    expect(callbacks.setGraphType).toHaveBeenCalledWith("value");
    expect(callbacks.setInterpolation).toHaveBeenCalledWith("step");
    for (const callback of [
      callbacks.fitSelection,
      callbacks.fitAll,
      callbacks.easyEase,
      callbacks.easyEaseIn,
      callbacks.easyEaseOut,
      callbacks.copy,
      callbacks.paste,
      callbacks.delete,
    ])
      expect(callback).toHaveBeenCalledOnce();
  });
});
