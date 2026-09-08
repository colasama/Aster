import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { type TimelineContextMenuActions, timelineContextMenuItems } from "./TimelineContextMenu";

function actions(): TimelineContextMenuActions {
  return {
    canAddLayerStyle: true,
    addLayerStyle: vi.fn(),
    canDeleteLayers: false,
    canEditKeyframes: false,
    canInterpolate: false,
    canInvertSelection: true,
    canPasteKeyframes: false,
    canPasteLayers: false,
    canSelectChildren: false,
    canSplitLayers: false,
    canMotionBlur: false,
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
    isMotionBlur: false,
    invertSelection: vi.fn(),
    locked: false,
    onClose: vi.fn(),
    openGraph: vi.fn(),
    pasteKeyframes: vi.fn(),
    pasteLayers: vi.fn(),
    precompose: vi.fn(),
    rename: vi.fn(),
    revealSource: vi.fn(),
    selectChildren: vi.fn(),
    selectedLayerCount: 1,
    setInterpolation: vi.fn(),
    splitLayers: vi.fn(),
    toggle3d: vi.fn(),
    toggleMotionBlur: vi.fn(),
    x: 0,
    y: 0,
  };
}

describe("timelineContextMenuItems", () => {
  it("adds layer styles through the layer submenu and excludes empty-space menus", () => {
    const current = actions();
    const items = timelineContextMenuItems(current, createTranslator("zh-CN"));
    const styles = items.find((item) => item.id === "layer-styles");
    if (styles?.kind !== "submenu") throw new Error("Missing layer styles menu");
    expect(styles.label).toBe("图层特效");
    expect(styles.items.map((item) => item.kind === "command" && item.label)).toEqual([
      "外发光",
      "阴影",
      "颜色填充",
    ]);
    for (const item of styles.items) if (item.kind === "command") item.onSelect();
    expect(current.addLayerStyle).toHaveBeenNthCalledWith(1, "outer-glow");
    expect(current.addLayerStyle).toHaveBeenNthCalledWith(2, "drop-shadow");
    expect(current.addLayerStyle).toHaveBeenNthCalledWith(3, "color-overlay");
    expect(
      timelineContextMenuItems({ ...current, locked: true }, createTranslator("en-US")).find(
        (item) => item.id === "layer-styles",
      ),
    ).toMatchObject({ disabled: true });
    expect(
      timelineContextMenuItems(
        { ...current, canAddLayerStyle: false },
        createTranslator("en-US"),
      ).find((item) => item.id === "layer-styles"),
    ).toMatchObject({ disabled: true });
    expect(
      timelineContextMenuItems(
        { ...current, isLayerTarget: false },
        createTranslator("en-US"),
      ).some((item) => item.id === "layer-styles"),
    ).toBe(false);
  });
  it("exposes layer operations and marks unavailable model actions with reasons", () => {
    const items = timelineContextMenuItems(actions(), createTranslator("en-US"));
    expect(items.find((item) => item.id === "split")).toMatchObject({
      disabled: true,
      disabledReason: "Move the current time inside every unlocked selected layer",
    });
    expect(items.find((item) => item.id === "motion-blur")).toMatchObject({ disabled: true });
  });

  it("routes split and selection commands with hierarchy-aware availability", () => {
    const splitLayers = vi.fn();
    const invertSelection = vi.fn();
    const selectChildren = vi.fn();
    const items = timelineContextMenuItems(
      {
        ...actions(),
        canSelectChildren: true,
        canSplitLayers: true,
        invertSelection,
        selectChildren,
        splitLayers,
      },
      createTranslator("en-US"),
    );
    for (const id of ["split", "invert-selection", "select-children"]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    expect(splitLayers).toHaveBeenCalledOnce();
    expect(invertSelection).toHaveBeenCalledOnce();
    expect(selectChildren).toHaveBeenCalledOnce();
  });

  it("exposes the persisted per-layer motion-blur switch when vectors are supported", () => {
    const toggleMotionBlur = vi.fn();
    const items = timelineContextMenuItems(
      { ...actions(), canMotionBlur: true, isMotionBlur: true, toggleMotionBlur },
      createTranslator("en-US"),
    );
    const item = items.find((candidate) => candidate.id === "motion-blur");
    expect(item).toMatchObject({ checked: true, disabled: false });
    if (item?.kind === "checkbox") item.onSelect();
    expect(toggleMotionBlur).toHaveBeenCalledOnce();
  });

  it("blocks destructive and edit actions with the locked-layer reason", () => {
    const items = timelineContextMenuItems(
      { ...actions(), locked: true, selectedLayerCount: 2 },
      createTranslator("en-US"),
    );
    for (const id of ["delete-layers", "rename", "split", "precompose"]) {
      expect(items.find((item) => item.id === id)).toMatchObject({
        disabled: true,
        disabledReason: "The selected layer is locked",
      });
    }
  });

  it("offers all source-free layer kinds on empty timeline space", () => {
    const empty = { ...actions(), isLayerTarget: false };
    const items = timelineContextMenuItems(empty, createTranslator("en-US"));
    const menu = items.find((item) => item.id === "new-layer");
    expect(menu?.kind === "submenu" && menu.items).toHaveLength(10);
  });

  it("routes keyframe interpolation, clipboard and delete callbacks", () => {
    const copyKeyframes = vi.fn();
    const deleteKeyframes = vi.fn();
    const pasteKeyframes = vi.fn();
    const setInterpolation = vi.fn();
    const items = timelineContextMenuItems(
      {
        ...actions(),
        canEditKeyframes: true,
        canInterpolate: true,
        canPasteKeyframes: true,
        copyKeyframes,
        deleteKeyframes,
        hasKeyframeClipboard: true,
        hasKeyframeSelection: true,
        pasteKeyframes,
        setInterpolation,
      },
      createTranslator("en-US"),
    );
    const interpolation = items.find((item) => item.id === "keyframe-interpolation");
    const bezier =
      interpolation?.kind === "submenu"
        ? interpolation.items.find((item) => item.id === "key-bezier")
        : undefined;
    if (bezier?.kind === "command") bezier.onSelect();
    for (const id of ["copy-keyframes", "paste-keyframes", "delete-keyframes"]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    expect(setInterpolation).toHaveBeenCalledWith("bezier");
    expect(copyKeyframes).toHaveBeenCalledOnce();
    expect(pasteKeyframes).toHaveBeenCalledOnce();
    expect(deleteKeyframes).toHaveBeenCalledOnce();
  });
});
