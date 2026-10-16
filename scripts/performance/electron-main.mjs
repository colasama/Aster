import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { CaptureDesktopAccess, DesktopBridgeClient } from "../parity/desktop-bridge.mjs";
import { captureLogIsFailure } from "../parity/electron-capture-session.mjs";
import { captureHostInfo } from "../parity/electron-host-info.mjs";
import { NativePerformanceOutputSession } from "./native-output-session.mjs";
import {
  normalizePerformanceIdentity,
  PerformanceOutputSession,
  publishPerformanceReport,
  validatePerformanceResult,
} from "./output-session.mjs";
import { PreviewOutputSession, validatePreviewResult } from "./preview.mjs";
import { loadRetainedPerformanceRuntime } from "./retained-runtime.mjs";

let config;
let bridge;
let manager;
let window;
let log;
let logCompletion;
let timer;
let stopping = false;
let index = 0;
let active;
let identity;
let published;
let report;
let retained;

function deadline(message) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void stop(new Error(message));
  }, config.timeoutMs ?? 600_000);
}

async function publish() {
  if (!published) {
    report.finished_at = new Date().toISOString();
    published = publishPerformanceReport(config.runDirectory, report);
  }
  await published;
  return report;
}

async function stop(error) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  const shutdown = setTimeout(() => {
    process.stderr.write("Performance shutdown exceeded its deadline\n");
    bridge?.dispose();
    app.exit(1);
  }, 10_000);
  try {
    if (error && report) {
      report.status = "failed";
      report.error = error.stack ?? String(error);
      if (active)
        report.cases.push({
          id: active.assignment.benchmark.id,
          caseId: active.assignment.case.id,
          benchmark: active.assignment.benchmark,
          status: "failed",
          error: report.error,
          output: active.output.report,
        });
      while (index < config.assignments.length) {
        const item = config.assignments[index++];
        report.cases.push({
          id: item.benchmark.id,
          caseId: item.case.id,
          benchmark: item.benchmark,
          status: "skipped",
          error: "Performance run aborted",
        });
      }
    }
    // Publish the failed run before cleanup, which can itself block on an encoder process.
    if (error && report) await publish();
    if (error) await active?.output.cancel();
    await manager?.dispose();
    await retained?.assertStable();
    if (report) await publish();
  } catch (failure) {
    process.stderr.write(`${failure.stack ?? failure}\n`);
    error = failure;
  }
  bridge?.dispose();
  window?.destroy();
  log?.end();
  await logCompletion;
  clearTimeout(shutdown);
  app.exit(error || report?.status !== "passed" ? 1 : 0);
}

process.on("uncaughtException", (error) => {
  void stop(error);
});
process.on("unhandledRejection", (error) => {
  void stop(error instanceof Error ? error : new Error(String(error)));
});

async function main() {
  try {
    if (!process.env.ASTER_PERFORMANCE_CONFIG)
      throw new Error("ASTER_PERFORMANCE_CONFIG must name a run configuration");
    config = JSON.parse(readFileSync(process.env.ASTER_PERFORMANCE_CONFIG, "utf8"));
    if (
      !Array.isArray(config.assignments) ||
      config.assignments.length === 0 ||
      !config.root ||
      !config.runDirectory ||
      !config.url ||
      !config.runId
    )
      throw new Error("Invalid performance configuration");
    // Scheme registration and Chromium switches must precede every asynchronous artifact audit.
    const registration = {
      scheme: "aster-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    };
    const profile = join(config.runDirectory, "profile");
    mkdirSync(profile, { recursive: true });
    protocol.registerSchemesAsPrivileged([registration]);
    app.setPath("userData", profile);
    for (const flag of [
      "force_high_performance_gpu",
      "disable-background-timer-throttling",
      "disable-renderer-backgrounding",
      "disable-backgrounding-occluded-windows",
    ])
      app.commandLine.appendSwitch(flag);
    if (config.retainedRuntime) retained = await loadRetainedPerformanceRuntime(config.root);
    const runtimeDirectory =
      retained?.runtimeDirectory ??
      config.nativeRuntime?.runtimeDirectory ??
      join(config.root, "dist-electron");
    const load = (name) => import(pathToFileURL(join(runtimeDirectory, name)).href);
    const assets = await load("electron/asset-protocol.js");
    assert.deepEqual(assets.ASSET_SCHEME_REGISTRATION, registration);
    if (retained) assert.deepEqual(config.source, retained.browser.rendererSource);
    const gpuMemory = await load("electron/gpu-memory.js");
    const files = await load("electron/local-file-response.js");
    const { Mp4ExportManager } = await load("electron/mp4-export.js");
    const preferences = await load("src/desktop/preferences.js");
    assert(
      !(config.retainedRuntime && config.nativeRuntime),
      "Reference and candidate runtimes must be independent",
    );
    const nativeOptions = config.nativeRuntime
      ? {
          ...(await load("electron/native-render-host-export.js")),
          ...(await load("electron/render-queue-host-protocol.js")),
          runtime: config.nativeRuntime,
        }
      : undefined;
    report = {
      schema_version: 1,
      run_id: config.runId,
      status: "running",
      started_at: new Date().toISOString(),
      source: config.source,
      hardware: config.hardware,
      host: null,
      ...(retained ? { retained_runtime: retained.provenance } : {}),
      cases: [],
    };
    mkdirSync(config.runDirectory, { recursive: true });
    log = createWriteStream(join(config.runDirectory, "electron.log"), { flags: "wx" });
    logCompletion = finished(log).catch(() => {});
    log.on("error", (error) => {
      log = undefined;
      void stop(error);
    });
    const writeLog = (kind, value) =>
      log?.write(`${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`);
    deadline("Performance Electron startup timed out");
    await app.whenReady();
    if (stopping) return;
    report.host = captureHostInfo(await app.getGPUInfo("complete"), app.getGPUFeatureStatus());
    const allowedAssets = new Map();
    protocol.handle(
      assets.ASSET_SCHEME,
      assets.createAssetProtocolHandler({ allowedAssets, fetchFile: files.fetchLocalAsset }),
    );
    const suffix = process.platform === "win32" ? ".exe" : "";
    const ffmpeg = config.binaries?.ffmpeg;
    const ffprobe = config.binaries?.ffprobe;
    if (
      typeof ffmpeg !== "string" ||
      typeof ffprobe !== "string" ||
      !statSync(ffmpeg).isFile() ||
      !statSync(ffprobe).isFile()
    )
      throw new Error("Performance config must bind the actual FFmpeg and FFprobe executables");
    manager = new Mp4ExportManager(ffmpeg);
    bridge = new DesktopBridgeClient(
      retained?.bridgePath ??
        config.nativeRuntime?.bridgePath ??
        join(config.root, "target", "release", `aster-desktop-bridge${suffix}`),
      profile,
      {
        timeoutMs: config.timeoutMs,
        log: (line) => writeLog("bridge", line),
        env: { ASTER_FFMPEG_PATH: ffmpeg, ASTER_FFPROBE_PATH: ffprobe },
      },
    );
    const access = new CaptureDesktopAccess(config, bridge, allowedAssets);
    const requireSender = (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        stopping
      )
        throw new Error("Performance IPC is not from the active renderer main frame");
    };
    const handle = (name, callback) =>
      ipcMain.handle(`aster:performance-${name}`, async (event, ...args) => {
        requireSender(event);
        try {
          return await callback(...args);
        } catch (error) {
          void stop(error);
          throw error;
        }
      });
    handle("desktop", (command, args) => access.invoke(command, args));
    handle("preferences", () => preferences.defaultAppPreferences());
    handle("gpu-memory", () => gpuMemory.detectGpuMemoryDevices());
    handle("ready", (value) => {
      if (active) throw new Error("Cannot change identity during a benchmark");
      const next = normalizePerformanceIdentity(value);
      if (identity && JSON.stringify(identity) !== JSON.stringify(next))
        throw new Error("Performance adapter or system fonts changed during the run");
      identity = next;
      report.host.cacheIdentity.webgpuAdapter = next.adapter;
      report.host.cacheIdentity.fonts = next.fonts;
    });
    handle("take", async () => {
      if (!identity || active)
        throw new Error(
          "Performance take requires readiness and completion of the previous assignment",
        );
      if (index === config.assignments.length) {
        deadline("Performance finalization timed out");
        return null;
      }
      const assignment = config.assignments[index++];
      const current = {
        assignment,
        completing: false,
        output: nativeOptions
          ? new NativePerformanceOutputSession(assignment, {
              ...nativeOptions,
              allowedAssets,
              ffmpeg,
              ffprobe,
              runDirectory: config.runDirectory,
              index,
            })
          : assignment.benchmark.mode === "preview-present"
            ? new PreviewOutputSession()
            : new PerformanceOutputSession(assignment, {
                manager,
                ownerId: window.webContents.id,
                runDirectory: config.runDirectory,
                index,
                ffprobe,
                timeoutMs: config.timeoutMs,
              }),
      };
      active = current;
      deadline(`Performance benchmark timed out: ${assignment.benchmark.id}`);
      await access.prepare(assignment);
      if (stopping || active !== current)
        throw new Error("Performance assignment expired during preparation");
      writeLog("take", assignment.benchmark);
      process.stdout.write(`Performance ready: ${assignment.benchmark.id}\n`);
      return assignment;
    });
    handle("output", (request) => {
      if (!active || active.completing) throw new Error("No benchmark is accepting output");
      return active.output.output(request);
    });
    handle("native-prepare", (manifest) => {
      if (!nativeOptions || !active || active.completing)
        throw new Error("No native benchmark is preparing");
      return active.output.prepare(manifest);
    });
    handle("native-warm", (frame, packet) => {
      if (!nativeOptions || !active || active.completing)
        throw new Error("No native benchmark is warming");
      return active.output.warm(frame, packet);
    });
    handle("complete", async (result) => {
      const current = active;
      if (!current || current.completing) throw new Error("No benchmark is awaiting completion");
      current.completing = true;
      if (nativeOptions) current.output.validate(result, identity.adapter);
      else
        (current.assignment.benchmark.mode === "preview-present"
          ? validatePreviewResult
          : validatePerformanceResult)(
          current.assignment,
          result,
          current.output.report,
          identity.adapter,
        );
      const output = await current.output.verify();
      if (stopping || active !== current)
        throw new Error("Performance completion expired during verification");
      report.cases.push({
        id: current.assignment.benchmark.id,
        caseId: current.assignment.case.id,
        case_hash: current.assignment.caseHash,
        inputs: current.assignment.inputs,
        benchmark: current.assignment.benchmark,
        status: "passed",
        result,
        output,
      });
      active = undefined;
      deadline("Renderer did not continue after its benchmark");
      process.stdout.write(
        `Performance passed: ${result.id} (${result.framesPerSecond.toFixed(2)} fps)\n`,
      );
    });
    handle("fail", (failure) => {
      void stop(new Error(failure?.error ?? "Performance renderer failed"));
    });
    handle("done", async () => {
      if (
        !identity ||
        active ||
        index !== config.assignments.length ||
        report.cases.length !== config.assignments.length
      )
        throw new Error("Performance renderer stopped with incomplete assignments");
      report.status = "passed";
      const result = await publish();
      setTimeout(() => {
        void stop();
      }, 100);
      return result;
    });
    ipcMain.on("aster:performance-log", (event, entry) => {
      try {
        requireSender(event);
        writeLog("renderer", entry);
        if (captureLogIsFailure(entry))
          void stop(
            new Error(
              `Production diagnostic failed: ${entry.scope}/${entry.event}: ${entry.error?.message ?? entry.message ?? "error"}`,
            ),
          );
      } catch (error) {
        writeLog("rejected-log", error.message);
      }
    });
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) => contents === window?.webContents && permission === "local-fonts",
    );
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
      callback(contents === window?.webContents && permission === "local-fonts"),
    );
    app.on("window-all-closed", () => {});
    app.on("child-process-gone", (_event, details) => {
      writeLog("child-process-gone", details);
      if (details.type === "GPU" && !stopping)
        void stop(new Error(`Performance GPU process exited: ${details.reason}`));
    });
    window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      width: 64,
      height: 64,
      backgroundColor: "#000000",
      webPreferences: {
        preload: resolve(import.meta.dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== config.url) event.preventDefault();
    });
    window.webContents.on("console-message", (details) =>
      writeLog("console", {
        level: details.level,
        message: details.message,
        lineNumber: details.lineNumber,
        sourceId: details.sourceId,
      }),
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      if (!stopping) void stop(new Error(`Performance renderer exited: ${details.reason}`));
    });
    await window.loadURL(config.url);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    await stop(error);
  }
}

void main();
