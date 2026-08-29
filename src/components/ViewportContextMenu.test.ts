import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type ViewportContextMenuActions, viewportContextMenuItems } from "./ViewportContextMenu";

function actions(): ViewportContextMenuActions {
  return {
    bufferView: "beauty",
    canCopyFrame: false,
    canExportFrame: true,
    copyFrame: vi.fn(),
    copyUnavailableReason: "Not ready",
    exportFrame: vi.fn(),
    exportUnavailableReason: "Not ready",
    onClose: vi.fn(),
    previewQuality: 0.5,
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
    expect(zoom?.kind === "submenu" && zoom.items).toHaveLength(4);
    expect(items.find((item) => item.id === "copy-frame")).toMatchObject({
      disabled: true,
      disabledReason: "Not ready",
    });
    expect(items.find((item) => item.id === "grid")).toMatchObject({ checked: true });
  });
});
