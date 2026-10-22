import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeRgbaPng } from "../parity/png.mjs";
import { hashFile } from "./source.mjs";

export const pluginLifecycleStates = [
  "missing",
  "installed",
  "reloaded",
  "rejected",
  "disabled",
  "enabled",
  "safe",
  "resumed",
  "removed",
];
export const previewPluginId = "org.aster.example.point-cloud";

/** Drive the production plugin manager against an isolated profile and authored root/nested scenes. */
export async function captureEditorPlugins({
  editor,
  call,
  root,
  output,
  nativeCalls,
  engine,
  dialog,
}) {
  const contents = editor.webContents;
  const evaluate = (code) => contents.executeJavaScript(code);
  const wait = async (read, accept, label) => {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const value = await read();
      if (accept(value)) return value;
      await delay(100);
    }
    throw new Error(`Plugin editor timed out: ${label}`);
  };
  const invoke = (command, args = {}) =>
    evaluate(`window.asterDesktop.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  await evaluate(
    `window.asterDesktop.updatePreferences({gpuMemoryBudgetMb:512,frameCacheBudgetMb:0,antiAliasing:'off',autosaveSeconds:0,reducedMotion:true,uiScale:1})`,
  );
  await new Promise((resolve) => {
    contents.once("did-finish-load", resolve);
    contents.reload();
  });
  await wait(
    () => evaluate("Boolean(document.querySelector('.preview-timecode'))"),
    Boolean,
    "ready",
  );
  assert.equal(
    await evaluate("window.asterDesktop.nativePreview.available()"),
    engine === "native",
  );
  const template = join(root, "artifacts/parity/projects/shape-rectangle/project.json");
  const project = JSON.parse(await readFile(template, "utf8"));
  const comp = project.compositions[0],
    generator = comp.layers[0];
  delete generator.shape;
  generator.kind = "generator";
  generator.name = "Installed point cloud";
  generator.size = [720, 720];
  generator.color = [1, 1, 1, 1];
  generator.transform.position = [160, 90, 0].map((value) => ({ mode: "static", value }));
  generator.transform.anchor = [360, 360, 0].map((value) => ({ mode: "static", value }));
  generator.transform.rotation = [0, 0, 0].map((value) => ({ mode: "static", value }));
  generator.generator = {
    pluginId: previewPluginId,
    nodeType: "point_cloud",
    apiVersion: 1,
    parameters: { count: 1, radius: 0.5, size: 16, color: [0.3, 0.7, 1.4] },
  };
  const fixtures = [];
  for (const layout of ["root", "nested"]) {
    const document = structuredClone(project);
    if (layout === "nested") {
      const child = structuredClone(comp);
      child.id = "cb17b25b-d3e4-4429-8b2b-a8b235ba629b";
      child.name = "Nested generator";
      const parent = structuredClone(generator);
      delete parent.generator;
      parent.kind = "precomposition";
      parent.sourceCompositionId = child.id;
      parent.size = [320, 180];
      parent.transform.anchor = [160, 90, 0].map((value) => ({ mode: "static", value }));
      document.compositions[0].layers = [parent];
      document.compositions.push(child);
      document.id = "1ac5879c-bf7e-4566-872e-4bb2dabfa149";
    }
    const directory = join(output, `plugin-project-${layout}`);
    await mkdir(directory);
    const path = join(directory, "project.json");
    await writeFile(path, JSON.stringify(document));
    fixtures.push({
      layout,
      directory,
      path,
      sha256: await hashFile(path),
      projectId: document.id,
    });
  }
  const openManager = async () => {
    await evaluate(`document.querySelector('[aria-controls="app-menu-edit"]').click()`);
    await wait(
      () => evaluate("Boolean(document.querySelector('#app-menu-edit'))"),
      Boolean,
      "edit menu",
    );
    await evaluate(
      `Array.from(document.querySelectorAll('#app-menu-edit [role="menuitem"]')).at(-1).click()`,
    );
    await wait(
      () =>
        evaluate(
          "Boolean(document.querySelector('.plugin-install-button:not(:disabled)') && document.querySelector('.plugin-safe-mode input:not(:disabled)'))",
        ),
      Boolean,
      "plugin manager",
    );
  };
  const closeManager = async () => {
    await evaluate(`document.querySelector('.workspace-dialog > header button').click()`);
    await wait(
      () => evaluate("!document.querySelector('.plugin-manager')"),
      Boolean,
      "manager closed",
    );
  };
  const toggle = async (selector, checked) => {
    await wait(
      () =>
        evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`,
        ),
      Boolean,
      selector,
    );
    await evaluate(
      `(() => {const node=document.querySelector(${JSON.stringify(selector)});if(node.checked!==${checked})node.click();})()`,
    );
  };
  const frames = [],
    transitions = [];
  const captureState = async (state) => {
    // Start each transition on the open composition to exercise live registry invalidation.
    const ordered =
      pluginLifecycleStates.indexOf(state) % 2 === 0 ? fixtures : [...fixtures].reverse();
    for (const fixture of ordered) {
      const context = await call("get_editor_context");
      const live = context.projectId === fixture.projectId;
      if (!live)
        await call("open_project", {
          path: fixture.directory,
          baseRevision: context.projectRevision,
        });
      await wait(
        () => call("get_editor_context"),
        (c) => c.projectId === fixture.projectId,
        "project open",
      );
      await wait(
        () =>
          evaluate(
            `Boolean(document.querySelector('button[aria-label*="Shift+F5"]:not(:disabled)'))`,
          ),
        Boolean,
        "preview ready",
      );
      await delay(150);
      const callStart = nativeCalls.length;
      await evaluate(
        `(() => {const canvas=document.querySelector('.viewport-snapshot');canvas.width=0;canvas.height=0;document.querySelector('button[aria-label*="Shift+F5"]').click();})()`,
      );
      const png = await wait(
        () =>
          evaluate(
            `(() => {const c=document.querySelector('.viewport-snapshot');return c?.width&&c.height?c.toDataURL('image/png'):null;})()`,
          ),
        Boolean,
        `snapshot ${state}/${fixture.layout}`,
      );
      const bytes = Buffer.from(png.split(",")[1], "base64"),
        image = decodeRgbaPng(bytes);
      assert.deepEqual([image.width, image.height], [320, 180]);
      const id = `${state}-${fixture.layout}`,
        path = join(output, `${id}.png`);
      await writeFile(path, bytes, { flag: "wx" });
      const frame = {
        id,
        live_transition: live,
        state,
        layout: fixture.layout,
        path,
        sha256: await hashFile(path),
        context: await call("get_editor_context"),
        native_calls: nativeCalls.slice(callStart),
      };
      frames.push(frame);
      await writeFile(
        join(output, "plugins-progress.json"),
        JSON.stringify({ frames, transitions }, null, 2),
      );
    }
  };
  await captureState("missing");
  await openManager();
  const originalDialog = dialog.showOpenDialog;
  const source = join(root, "examples/plugins/point-cloud");
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  try {
    await evaluate("document.querySelector('.plugin-install-button').click()");
    await wait(
      () => invoke("plugin_status"),
      (s) => s.report.plugins.some((p) => p.plugin.id === previewPluginId),
      "installed",
    );
  } finally {
    dialog.showOpenDialog = originalDialog;
  }
  const installed = await invoke("plugin_status");
  const owned = relative(output, installed.directory);
  assert(
    owned && !owned.startsWith("..") && !owned.includes(":"),
    "Plugin fixture must stay in isolated output profile",
  );
  const installedDirectory = join(installed.directory, previewPluginId);
  const shaderPath = join(installedDirectory, "render.wgsl"),
    shader = await readFile(shaderPath, "utf8");
  const originalHash = await hashFile(shaderPath);
  await toggle(".plugin-hot-reload input", true);
  await wait(
    () => invoke("plugin_status"),
    (s) => s.hotReload.enabled,
    "hot reload enabled",
  );
  await closeManager();
  transitions.push({ state: "installed", status: installed, shader_sha256: originalHash });
  await captureState("installed");
  await openManager();
  const before = await invoke("plugin_status");
  const changedShader = shader.replace(
    "aster_parameters.values[3].xyz * alpha",
    "aster_parameters.values[3].zyx * alpha",
  );
  assert.notEqual(changedShader, shader);
  await writeFile(shaderPath, changedShader);
  const reloaded = await wait(
    () => invoke("plugin_status"),
    (s) => s.hotReload.successfulReloads > before.hotReload.successfulReloads,
    "valid reload",
  );
  await delay(1000);
  transitions.push({
    state: "reloaded",
    status: reloaded,
    shader_sha256: await hashFile(shaderPath),
  });
  await closeManager();
  await captureState("reloaded");
  await openManager();
  await writeFile(shaderPath, "invalid WGSL fixture");
  const rejected = await wait(
    () => invoke("plugin_status"),
    (s) => s.hotReload.rejectedReloads > reloaded.hotReload.rejectedReloads,
    "rejected reload",
  );
  await delay(1000);
  transitions.push({
    state: "rejected",
    status: rejected,
    shader_sha256: await hashFile(shaderPath),
  });
  await closeManager();
  await captureState("rejected");
  // Restore a valid package before testing independent policy transitions.
  await writeFile(shaderPath, changedShader);
  for (const [state, selector, checked, accept] of [
    ["disabled", ".plugin-list article input", false, (s) => s.disabled.includes(previewPluginId)],
    ["enabled", ".plugin-list article input", true, (s) => !s.disabled.includes(previewPluginId)],
    ["safe", ".plugin-safe-mode input", true, (s) => s.safeMode],
    ["resumed", ".plugin-safe-mode input", false, (s) => !s.safeMode],
  ]) {
    await openManager();
    await toggle(selector, checked);
    const status = await wait(() => invoke("plugin_status"), accept, state);
    await delay(200);
    transitions.push({ state, status });
    await closeManager();
    await captureState(state);
  }
  await openManager();
  await rename(installedDirectory, join(output, "removed-plugin"));
  const removed = await wait(
    () => invoke("plugin_status"),
    (s) => !s.report.plugins.some((p) => p.plugin.id === previewPluginId),
    "removed plugin",
  );
  await delay(1000);
  transitions.push({ state: "removed", status: removed });
  await closeManager();
  await captureState("removed");
  for (const layout of ["root", "nested"]) {
    const hash = (state) =>
      frames.find((frame) => frame.state === state && frame.layout === layout).sha256;
    assert.notEqual(
      hash("installed"),
      hash("missing"),
      "Installed plugin produced no visible pixels",
    );
    assert.notEqual(hash("reloaded"), hash("installed"), "Valid reload did not change pixels");
    for (const state of ["rejected", "enabled", "resumed"])
      assert.equal(hash(state), hash("reloaded"));
    for (const state of ["disabled", "safe", "removed"]) assert.equal(hash(state), hash("missing"));
  }
  return {
    status: "passed",
    fixtures,
    frames,
    transitions,
    template: { path: template, sha256: await hashFile(template) },
    source,
  };
}
