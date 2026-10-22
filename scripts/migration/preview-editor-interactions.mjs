import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeRgbaPng } from "../parity/png.mjs";
import { hashFile } from "./source.mjs";

export const editorInteractionModes = [
  "beauty",
  "linearColor",
  "luminance",
  "alpha",
  "normal",
  "objectId",
  "materialId",
  "worldPosition",
  "motionVector",
  "depthFog",
  "depthOfField",
  "selectionIsolation",
  "vectorMotionBlur",
];

/** Exercise ordinary editor controls against one immutable fixture in either rendering engine. */
export async function captureEditorInteractions({
  editor,
  call,
  root,
  output,
  nativeCalls,
  engine,
}) {
  assert(editor, "Editor window is missing");
  const contents = editor.webContents;
  const fixture = join(root, "artifacts/parity/projects/shape-rectangle/project.json");
  const document = JSON.parse(await readFile(fixture, "utf8"));
  const projectPath = join(output, "interaction-project");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "project.json"), JSON.stringify(document));
  await contents.executeJavaScript(`window.asterDesktop.updatePreferences({
    gpuMemoryBudgetMb:512,frameCacheBudgetMb:0,antiAliasing:'off',autosaveSeconds:0,reducedMotion:true,uiScale:1
  })`);
  await new Promise((resolve) => {
    contents.once("did-finish-load", resolve);
    contents.reload();
  });
  const wait = async (read, accept, label) => {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const value = await read();
      if (accept(value)) return value;
      await delay(50);
    }
    throw new Error(`Editor interaction timed out: ${label}`);
  };
  await wait(
    () => contents.executeJavaScript(`Boolean(document.querySelector('.preview-timecode'))`),
    Boolean,
    "editor ready",
  );
  assert.equal(
    await contents.executeJavaScript("window.asterDesktop.nativePreview.available()"),
    engine === "native",
    "Requested preview engine is unavailable; renderer fallback cannot qualify this witness",
  );
  const context = await call("get_editor_context");
  await call("open_project", { path: projectPath, baseRevision: context.projectRevision });
  await wait(
    () => call("get_editor_context"),
    (value) => value.projectId === document.id,
    "fixture open",
  );
  await wait(
    () =>
      contents.executeJavaScript(`(() => {
    const button=document.querySelector('button[aria-label*="Shift+F5"]');
    return button && !button.disabled;
  })()`),
    Boolean,
    "preview ready",
  );
  await contents.executeJavaScript(`(() => {
    const input=document.querySelector('.preview-timecode');input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'7f');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  contents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await wait(
    () => call("get_editor_context"),
    (value) => value.currentTime === 7 / 30,
    "exact playhead seek",
  );
  const frames = [];
  const capture = async (id, mode) => {
    const callStart = nativeCalls.length;
    await contents.executeJavaScript(`(() => {
      const select=[...document.querySelectorAll('select')].find(node=>[...node.options].some(option=>option.value==='normal'));
      if(!select || select.disabled)throw new Error('Diagnostic selector unavailable');
      select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await delay(100);
    await contents.executeJavaScript(`(() => {
      const canvas=document.querySelector('.viewport-snapshot');canvas.width=0;canvas.height=0;
      document.querySelector('button[aria-label*="Shift+F5"]').click();
    })()`);
    const png = await wait(
      () =>
        contents.executeJavaScript(`(() => {
      const canvas=document.querySelector('.viewport-snapshot');
      return canvas?.width && canvas.height ? canvas.toDataURL('image/png') : null;
    })()`),
      Boolean,
      `snapshot ${id}`,
    );
    const bytes = Buffer.from(png.split(",")[1], "base64"),
      image = decodeRgbaPng(bytes);
    assert.equal(image.width, 320);
    assert.equal(image.height, 180);
    const path = join(output, `interaction-${id}.png`);
    await writeFile(path, bytes, { flag: "wx" });
    frames.push({
      id,
      mode,
      path,
      sha256: await hashFile(path),
      context: await call("get_editor_context"),
      native_calls: nativeCalls.slice(callStart),
    });
    await writeFile(
      join(output, "interactions-progress.json"),
      JSON.stringify({ frames }, null, 2),
    );
    return frames[frames.length - 1];
  };
  const box = await contents.executeJavaScript(`(() => {
    const rect=document.querySelector('.composition-stage canvas').getBoundingClientRect();
    return {x:rect.x+rect.width*163.25/320,y:rect.y+rect.height*85.75/180};
  })()`);
  contents.sendInputEvent({
    type: "mouseDown",
    x: Math.round(box.x),
    y: Math.round(box.y),
    button: "left",
    clickCount: 1,
  });
  contents.sendInputEvent({
    type: "mouseUp",
    x: Math.round(box.x),
    y: Math.round(box.y),
    button: "left",
    clickCount: 1,
  });
  await wait(
    () => call("get_editor_context"),
    (value) => value.selection.includes(document.compositions[0].layers[0].id),
    "layer selected",
  );
  for (const mode of editorInteractionModes) await capture(mode, mode);
  const before = await call("get_editor_context");
  await contents.executeJavaScript(`document.querySelector('.viewport-selection-hit').focus()`);
  contents.sendInputEvent({ type: "keyDown", keyCode: "Right", modifiers: ["shift"] });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Right", modifiers: ["shift"] });
  const moved = await wait(
    () => call("get_editor_context"),
    (value) => value.projectRevision > before.projectRevision,
    "direct layer movement",
  );
  assert.equal(moved.currentTime, before.currentTime);
  const movedFrame = await capture("moved", "beauty");
  assert.notEqual(movedFrame.sha256, frames[0].sha256, "Layer movement did not change pixels");
  contents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
  await wait(
    () => call("get_editor_context"),
    (value) => value.projectRevision > moved.projectRevision,
    "undo movement",
  );
  const restored = await capture("restored", "beauty");
  assert.equal(restored.sha256, frames[0].sha256, "Undo did not restore exact pixels");
  const dragBefore = await call("get_editor_context");
  // Start inside the selection away from its anchor control, which intentionally preserves pixels.
  const start = { x: Math.round(box.x) + 20, y: Math.round(box.y) };
  const end = { x: start.x + 36, y: start.y + 24 };
  contents.sendInputEvent({
    type: "mouseDown",
    ...start,
    button: "left",
    clickCount: 1,
    modifiers: ["control"],
  });
  contents.sendInputEvent({ type: "mouseMove", ...end, modifiers: ["leftButtonDown", "control"] });
  const dragged = await wait(
    () => call("get_editor_context"),
    (value) => value.projectRevision > dragBefore.projectRevision,
    "drag preview operation",
  );
  assert.equal(dragged.currentTime, dragBefore.currentTime);
  const dragFrame = await capture("drag-preview", "beauty");
  assert.notEqual(dragFrame.sha256, frames[0].sha256);
  contents.sendInputEvent({
    type: "mouseUp",
    ...end,
    button: "left",
    clickCount: 1,
    modifiers: ["control"],
  });
  const committed = await wait(
    () => call("get_editor_context"),
    (value) => value.projectRevision > dragged.projectRevision,
    "drag commit",
  );
  const committedFrame = await capture("drag-committed", "beauty");
  assert.equal(
    committedFrame.sha256,
    dragFrame.sha256,
    "Committing a gesture changed its preview pixels",
  );
  await contents.executeJavaScript(`document.querySelector('.viewport-selection-hit').focus()`);
  contents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
  await wait(
    () => call("get_editor_context"),
    (value) => value.projectRevision > committed.projectRevision,
    "undo drag",
  );
  assert.equal((await capture("drag-restored", "beauty")).sha256, frames[0].sha256);
  return {
    status: "passed",
    fixture: { path: fixture, sha256: await hashFile(fixture) },
    frames,
    movement: { before, after: moved },
    drag: { before: dragBefore, preview: dragged, committed },
    restored: true,
  };
}
