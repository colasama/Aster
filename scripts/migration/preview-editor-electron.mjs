import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { captureHostInfo } from "../parity/electron-host-info.mjs";
import { captureEditorInteractions } from "./preview-editor-interactions.mjs";
import { captureEditorPlugins } from "./preview-editor-plugins.mjs";
import { capturePreviewInputLatency } from "./preview-input-latency.mjs";
import { captureInitialPreview, captureReadyBenchmark } from "./preview-readiness.mjs";
import { writeAtomicJson } from "./report.mjs";

const root = process.cwd(),
  output = process.env.ASTER_PREVIEW_EDITOR_OUTPUT;
const engine = process.env.ASTER_PREVIEW_ENGINE ?? "native";
assert(["native", "ts"].includes(engine));
const report = {
  status: "failed",
  scope: "development-editor-native-preview",
  engine,
  native_calls: [],
  steps: [],
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  register(channel, async (...args) => {
    const value = await handler(...args);
    if (channel.startsWith("aster:native-preview-") && channel !== "aster:native-preview-available")
      report.native_calls.push({
        channel,
        time: channel.endsWith("present") ? args[2] : undefined,
        request: args[3],
        timings: value?.timings,
        ready: value?.ready ?? (channel.endsWith("replace") ? value : undefined),
      });
    return value;
  });
await mkdir(join(output, "temp"), { recursive: true });
app.setAppPath(root);
app.commandLine.appendSwitch("user-data-dir", join(output, "profile"));
app.setPath("userData", join(output, "profile"));
app.setPath("temp", join(output, "temp"));
process.argv.push("--automation-background");
const server = createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
process.env.ASTER_NATIVE_PREVIEW = engine === "native" ? "1" : "0";
process.env.ASTER_AUTOMATION_ENABLED = "1";
process.env.ASTER_AUTOMATION_PORT = String(port);
process.env.ASTER_FFMPEG_PATH = join(root, "build/ffmpeg/ffmpeg.exe");
process.env.ASTER_FFPROBE_PATH = join(root, "build/ffmpeg/ffprobe.exe");
await import(pathToFileURL(join(root, "dist-electron/electron/main.js")));

async function main() {
  try {
    await app.whenReady();
    report.host = captureHostInfo(await app.getGPUInfo("complete"), app.getGPUFeatureStatus());
    const started = Date.now();
    while (true) {
      const ready = await fetch(`http://127.0.0.1:${port}/tools`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) break;
      if (Date.now() - started > 60000) throw new Error("Editor automation did not start");
      await delay(250);
    }
    const call = async (name, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "native-preview-witness", name, arguments: args }),
      });
      const body = await response.json();
      if (body.error)
        throw new Error(`${name}: ${JSON.stringify(body.errorDetails ?? body.error)}`);
      report.steps.push({ name });
      return body.result;
    };
    const latencySamples = Number(process.env.ASTER_PREVIEW_LATENCY_SAMPLES ?? 0);
    const editor = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith("/index.html"),
    );
    if (latencySamples > 0) {
      assert(editor);
      await editor.webContents.executeJavaScript(`window.asterDesktop.updatePreferences({
        gpuMemoryBudgetMb:1024,frameCacheBudgetMb:0,antiAliasing:'off',autosaveSeconds:0,reducedMotion:true,uiScale:1
      })`);
      await new Promise((resolve) => {
        editor.webContents.once("did-finish-load", resolve);
        editor.webContents.reload();
      });
      await delay(1000);
    }
    let context = await call("get_editor_context");
    if (process.env.ASTER_PREVIEW_OWNER_PROJECT) {
      report.owner = await call("open_project", {
        path: process.env.ASTER_PREVIEW_OWNER_PROJECT,
        baseRevision: context.projectRevision,
      });
      context = await call("get_editor_context");
    }
    if (process.env.ASTER_PREVIEW_PLUGINS === "1") {
      report.plugins = await captureEditorPlugins({
        editor,
        call,
        root,
        output,
        nativeCalls: report.native_calls,
        engine,
        dialog,
      });
    } else if (process.env.ASTER_PREVIEW_INTERACTIONS === "1") {
      report.interactions = await captureEditorInteractions({
        editor,
        call,
        root,
        output,
        nativeCalls: report.native_calls,
        engine,
      });
    } else if (process.env.ASTER_PREVIEW_BENCHMARK_ONLY !== "1") {
      const changed = await call("execute_aster_code", {
        baseRevision: context.projectRevision,
        commands: [
          {
            type: "addComposition",
            name: "Native preview editor",
            width: 320,
            height: 180,
            frameRateNumerator: 30,
            frameRateDenominator: 1,
            duration: 2,
            activate: true,
          },
          { type: "addLayer", kind: "solid", name: "Native block" },
        ],
      });
      const work = {
        workspaceId: changed.workspaceId,
        workspaceRevision: changed.workspaceRevision,
      };
      const before = report.native_calls.filter(
        (c) => c.channel === "aster:native-preview-present",
      ).length;
      report.preview_attempts = [];
      const frames = await captureInitialPreview(
        () => call("render_preview", { ...work, times: [0, 0.123456789, 1], maxDimension: 320 }),
        report.preview_attempts,
      );
      assert.equal(frames.frames.length, 3);
      assert.equal(frames.frames[0].width, 320);
      const native = report.native_calls
        .filter((c) => c.channel === "aster:native-preview-present")
        .slice(before);
      if (engine === "native")
        assert(
          native.some((c) => c.time === 0.123456789),
          "Editor capture did not call the native time-addressed route",
        );
      else assert.equal(report.native_calls.length, 0);
      report.preview = frames;
      const resized = await call("render_preview", { ...work, times: [0.5], maxDimension: 160 });
      assert.equal(resized.frames[0].width, 160);
      report.resize = resized.frames.map((f) => ({ width: f.width, height: f.height }));
      if (engine === "native")
        assert(
          report.native_calls.some((c) => c.ready?.source?.kind === "project"),
          "Editor did not open a native project",
        );
    }
    const samples = Number(process.env.ASTER_PREVIEW_BENCHMARK_SAMPLES ?? 0);
    if (samples > 0) {
      assert(Number.isSafeInteger(samples) && samples <= 600);
      const editor = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().endsWith("/index.html"),
      );
      assert(editor, "Primary editor window missing");
      const scenario = process.env.ASTER_PREVIEW_BENCHMARK_SCENARIO;
      report.benchmark_attempts = [];
      report.benchmark = await captureReadyBenchmark(
        () =>
          editor.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        let accepted = false;
        window.dispatchEvent(new CustomEvent("aster:run-gpu-benchmark", { detail: {
          sampleFrames: ${samples}, memoryBudgetMb: 1024,
          expectedCompositionId: ${JSON.stringify(process.env.ASTER_PREVIEW_BENCHMARK_COMPOSITION ?? null)} ?? undefined,
          onProgress(scenario, completed, total) { if (completed % 100 === 0) console.info("preview-benchmark-progress", JSON.stringify({scenario, completed, total})); },
          accept() { accepted = true; }, resolve, reject,
          scenarioNames: ${JSON.stringify(scenario ? [scenario] : null)} ?? undefined
        }}));
        queueMicrotask(() => { if (!accepted) reject(new Error("Editor benchmark was not claimed")); });
      })`),
        report.benchmark_attempts,
      );
      if (engine === "native") assert.equal(report.benchmark.backend, "native-preview");
      else assert.notEqual(report.benchmark.backend, "native-preview");
      assert.equal(report.benchmark.scenarios.length, scenario ? 1 : 7);
    }
    if (latencySamples > 0) {
      report.latency_readiness = [];
      if (samples === 0)
        await captureReadyBenchmark(
          () =>
            editor.webContents.executeJavaScript(`new Promise((resolve,reject) => {
        let accepted=false;
        window.dispatchEvent(new CustomEvent('aster:run-gpu-benchmark',{detail:{
          sampleFrames:1,memoryBudgetMb:1024,
          expectedCompositionId:${JSON.stringify(context.activeComposition.id)},
          scenarioNames:['1080p current composition'],onProgress(){},
          accept(){accepted=true},resolve,reject
        }}));
        queueMicrotask(() => {if(!accepted)reject(new Error('Editor benchmark was not claimed'))});
      })`),
          report.latency_readiness,
        );
      report.latency = await capturePreviewInputLatency(editor, call, output, latencySamples);
    }
    await fetch(`http://127.0.0.1:${port}/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "native-preview-witness" }),
    });
    report.status = "passed";
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    await writeAtomicJson(join(output, "report.json"), report);
    app.quit();
    const timeout = setTimeout(() => app.exit(report.status === "passed" ? 0 : 1), 10000);
    timeout.unref();
  }
}
void main();
