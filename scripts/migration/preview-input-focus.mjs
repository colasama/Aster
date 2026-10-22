import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Bounded setup only: measured input is never retried or silently refocused. */
export async function preparePreviewInputFocus(editor, phase, observations, wait = delay) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    editor.show();
    editor.moveTop();
    editor.focus();
    editor.webContents.focus();
    await wait(100);
    const focused = editor.isFocused();
    const documentFocused = await editor.webContents.executeJavaScript("document.hasFocus()");
    observations.push({ phase, attempt, focused, document_focused: documentFocused });
    if (focused && documentFocused) return;
  }
  assert.fail(`Preview input focus preparation failed: ${phase}`);
}
