import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type ViewportContextMenuActions, viewportContextMenuItems } from "./ViewportContextMenu";

function actions(): ViewportContextMenuActions {
  return {
    bufferView: "beauty",
    canCopyFrame: false,
    canCropComposition: false,
    canEditComposition: true,
    canExportFrame: true,
    canInvertSelection: false,
    canSelectChildren: false,
    copyFrame: vi.fn(),
    cropComposition: vi.fn(),
    cropUnavailableReason: "Select a visual layer",
    copyUnavailableReason: "Not ready",
    exportFrame: vi.fn(),
    exportUnavailableReason: "Not ready",
    invertSelection: vi.fn(),
    onClose: vi.fn(),
    openCompositionSettings: vi.fn(),
    previewQuality: 0.5,
    revealComposition: vi.fn(),
    selectChildren: vi.fn(),
    setBufferView: vi.fn(),
    setPreviewQuality: vi.fn(),
    setViewCount: vi.fn(),
    setZoom: vi.fn(),
    showGrid: true,
    showGuides: false,
    showLayerControls: true,
    showOrigin: false,
    toggleGrid: vi.fn(),
    toggleGuides: vi.fn(),
    toggleLayerControls: vi.fn(),
    toggleOrigin: vi.fn(),
    viewCount: 2,
    x: 0,
    y: 0,
    zoom: 0.5,
  };
}

describe("viewportContextMenuItems", () => {
  it("exposes nested preview choices, overlays, and capture availability", () => {
    const items = viewportContextMenuItems(actions(), createTranslator("en-US"));
    const zoom = items.find((item) => item.kind === "submenu" && item.id === "zoom");
    expect(zoom?.kind === "submenu" && zoom.items).toHaveLength(6);
    expect(
      zoom?.kind === "submenu" && zoom.items.find((item) => item.id === "zoom-8"),
    ).toMatchObject({ label: "800%" });
    expect(items.find((item) => item.id === "copy-frame")).toMatchObject({
      disabled: true,
      disabledReason: "Not ready",
    });
    expect(items.find((item) => item.id === "grid")).toMatchObject({ checked: true });
    expect(items.find((item) => item.id === "crop-composition")).toMatchObject({
      disabled: true,
      disabledReason: "Select a visual layer",
    });
    expect(items.find((item) => item.id === "invert-selection")).toMatchObject({
      disabled: true,
    });
  });

  it("routes composition commands to real actions", () => {
    const openCompositionSettings = vi.fn();
    const revealComposition = vi.fn();
    const cropComposition = vi.fn();
    const invertSelection = vi.fn();
    const selectChildren = vi.fn();
    const items = viewportContextMenuItems(
      {
        ...actions(),
        canCropComposition: true,
        canInvertSelection: true,
        canSelectChildren: true,
        cropComposition,
        invertSelection,
        openCompositionSettings,
        revealComposition,
        selectChildren,
      },
      createTranslator("en-US"),
    );
    for (const id of [
      "composition-settings",
      "reveal-composition",
      "crop-composition",
      "invert-selection",
      "select-children",
    ]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    expect(openCompositionSettings).toHaveBeenCalledOnce();
    expect(revealComposition).toHaveBeenCalledOnce();
    expect(cropComposition).toHaveBeenCalledOnce();
    expect(invertSelection).toHaveBeenCalledOnce();
    expect(selectChildren).toHaveBeenCalledOnce();
  });

  it("omits composition editing for a locked non-active viewer", () => {
    const items = viewportContextMenuItems(
      { ...actions(), canEditComposition: false },
      createTranslator("en-US"),
    );
    expect(items.some((item) => item.id === "composition-settings")).toBe(false);
    expect(items.some((item) => item.id === "reveal-composition")).toBe(true);
    expect(items.some((item) => item.id === "export-frame")).toBe(true);
  });
});
