import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type TimelineContextMenuActions, timelineContextMenuItems } from "./TimelineContextMenu";

function actions(): TimelineContextMenuActions {
  return {
    canDeleteLayers: false,
    canEditKeyframes: false,
    canInterpolate: false,
    canPasteKeyframes: false,
    canPasteLayers: false,
    copyKeyframes: vi.fn(),
    copyLayers: vi.fn(),
    createLayer: vi.fn(),
    cutLayers: vi.fn(),
    deleteKeyframes: vi.fn(),
    deleteLayers: vi.fn(),
    duplicateLayers: vi.fn(),
    hasKeyframeSelection: false,
    hasKeyframeClipboard: false,
    hasSource: false,
    is3d: false,
    isAdjustment: false,
    isLayerTarget: true,
    locked: false,
    onClose: vi.fn(),
    openGraph: vi.fn(),
    pasteKeyframes: vi.fn(),
    pasteLayers: vi.fn(),
    precompose: vi.fn(),
    rename: vi.fn(),
    revealSource: vi.fn(),
    selectedLayerCount: 1,
    setInterpolation: vi.fn(),
    toggle3d: vi.fn(),
    x: 0,
    y: 0,
  };
}

describe("timelineContextMenuItems", () => {
  it("exposes layer operations and marks unavailable model actions with reasons", () => {
    const items = timelineContextMenuItems(actions(), createTranslator("en-US"));
    expect(items.find((item) => item.id === "split")).toMatchObject({
      disabled: true,
      disabledReason: "Layer splitting is not available in the current model",
    });
    expect(items.find((item) => item.id === "motion-blur")).toMatchObject({ disabled: true });
  });

  it("offers all source-free layer kinds on empty timeline space", () => {
    const empty = { ...actions(), isLayerTarget: false };
    const items = timelineContextMenuItems(empty, createTranslator("en-US"));
    const menu = items.find((item) => item.id === "new-layer");
    expect(menu?.kind === "submenu" && menu.items).toHaveLength(13);
    expect(
      menu?.kind === "submenu" && menu.items.find((item) => item.id === "new-image"),
    ).toMatchObject({ disabled: true, disabledReason: "Import or select a project source first" });
  });
});
