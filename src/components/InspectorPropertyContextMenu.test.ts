import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import {
  type InspectorPropertyContextMenuActions,
  inspectorPropertyContextMenuItems,
} from "./InspectorPropertyContextMenu";

describe("inspectorPropertyContextMenuItems", () => {
  it("switches the keyframe command and explains disabled paste", () => {
    const actions: InspectorPropertyContextMenuActions = {
      addKeyframe: vi.fn(),
      canEdit: true,
      canPaste: false,
      copy: vi.fn(),
      disabledReason: "Locked",
      hasKeyframe: true,
      label: "Opacity",
      onClose: vi.fn(),
      paste: vi.fn(),
      removeKeyframe: vi.fn(),
      reset: vi.fn(),
      revealInTimeline: vi.fn(),
      x: 0,
      y: 0,
    };
    const items = inspectorPropertyContextMenuItems(actions, createTranslator("en-US"));
    expect(items.find((item) => item.id === "remove-keyframe")).toBeDefined();
    expect(items.find((item) => item.id === "paste")).toMatchObject({
      disabled: true,
      disabledReason: "The property clipboard is empty",
    });
  });

  it("routes value, clipboard, keyframe, and timeline actions", () => {
    const callbacks = {
      addKeyframe: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      removeKeyframe: vi.fn(),
      reset: vi.fn(),
      revealInTimeline: vi.fn(),
    };
    const items = inspectorPropertyContextMenuItems(
      {
        ...callbacks,
        canEdit: true,
        canPaste: true,
        disabledReason: "Locked",
        hasKeyframe: false,
        label: "Opacity",
        onClose: vi.fn(),
        x: 0,
        y: 0,
      },
      createTranslator("en-US"),
    );
    for (const id of ["reset", "copy", "paste", "add-keyframe", "reveal"]) {
      const item = items.find((candidate) => candidate.id === id);
      if (item?.kind === "command") item.onSelect();
    }
    expect(callbacks.reset).toHaveBeenCalledOnce();
    expect(callbacks.copy).toHaveBeenCalledOnce();
    expect(callbacks.paste).toHaveBeenCalledOnce();
    expect(callbacks.addKeyframe).toHaveBeenCalledOnce();
    expect(callbacks.revealInTimeline).toHaveBeenCalledOnce();
    expect(callbacks.removeKeyframe).not.toHaveBeenCalled();
  });

  it("keeps locked property mutations disabled with a reason", () => {
    const items = inspectorPropertyContextMenuItems(
      {
        addKeyframe: vi.fn(),
        canEdit: false,
        canPaste: true,
        copy: vi.fn(),
        disabledReason: "The layer is locked",
        hasKeyframe: false,
        label: "Opacity",
        onClose: vi.fn(),
        paste: vi.fn(),
        removeKeyframe: vi.fn(),
        reset: vi.fn(),
        revealInTimeline: vi.fn(),
        x: 0,
        y: 0,
      },
      createTranslator("en-US"),
    );
    for (const id of ["reset", "paste", "add-keyframe"])
      expect(items.find((item) => item.id === id)).toMatchObject({
        disabled: true,
        disabledReason: "The layer is locked",
      });
  });
});
