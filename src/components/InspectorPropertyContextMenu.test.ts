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
});
