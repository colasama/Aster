// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { isComposingKeyboardEvent, isEditableShortcutTarget } from "./keyboard-shortcuts";

describe("keyboard shortcut guards", () => {
  it("recognizes active and legacy IME key events", () => {
    expect(isComposingKeyboardEvent({ isComposing: true, key: "Enter" })).toBe(true);
    expect(isComposingKeyboardEvent({ isComposing: false, key: "Process" })).toBe(true);
    expect(isComposingKeyboardEvent({ isComposing: false, key: "v" })).toBe(false);
  });

  it("recognizes native and contenteditable editing targets", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    const child = document.createElement("span");
    editor.contentEditable = "true";
    editor.append(child);
    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(child)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement("button"))).toBe(false);
  });
});
