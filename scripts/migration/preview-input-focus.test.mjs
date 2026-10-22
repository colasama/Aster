import assert from "node:assert/strict";
import test from "node:test";
import { preparePreviewInputFocus } from "./preview-input-focus.mjs";

function fixture(states) {
  let index = -1;
  const calls = [];
  const editor = {
    show() {
      calls.push("show");
      index++;
    },
    moveTop() {
      calls.push("moveTop");
    },
    focus() {
      calls.push("focus");
    },
    isFocused: () => states[Math.min(index, states.length - 1)][0],
    webContents: {
      focus() {
        calls.push("contents.focus");
      },
      async executeJavaScript(code) {
        assert.equal(code, "document.hasFocus()");
        return states[Math.min(index, states.length - 1)][1];
      },
    },
  };
  return { editor, calls };
}

test("setup requires both native window and document focus", async () => {
  const { editor, calls } = fixture([
    [false, true],
    [true, false],
    [true, true],
  ]);
  const observations = [];
  await preparePreviewInputFocus(editor, "calibration-1", observations, async (ms) =>
    assert.equal(ms, 100),
  );
  assert.equal(observations.length, 3);
  assert.deepEqual(observations.at(-1), {
    phase: "calibration-1",
    attempt: 3,
    focused: true,
    document_focused: true,
  });
  assert.equal(calls.length, 12);
});

test("persistent focus failure stops after bounded setup attempts", async () => {
  const { editor } = fixture([[false, false]]),
    observations = [];
  await assert.rejects(
    preparePreviewInputFocus(editor, "measurement", observations, async () => {}),
    /focus preparation failed: measurement/,
  );
  assert.equal(observations.length, 10);
  assert(observations.every((item) => !item.focused && !item.document_focused));
});
