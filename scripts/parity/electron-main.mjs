import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import * as assets from "../../dist-electron/electron/asset-protocol.js";
import * as gpuMemory from "../../dist-electron/electron/gpu-memory.js";
import * as files from "../../dist-electron/electron/local-file-response.js";
import * as preferences from "../../dist-electron/src/desktop/preferences.js";
import { CaptureStore } from "./capture-store.mjs";
import { CaptureDesktopAccess, DesktopBridgeClient } from "./desktop-bridge.mjs";
import { CaptureSession } from "./electron-capture-session.mjs";
import { captureHostInfo } from "./electron-host-info.mjs";

let capture;
let bridge;
let window;
let log;
let logCompletion;
let startupTimer;
let stopping = false;
let store;
let config;

async function stop(error) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  const shutdownTimer = setTimeout(() => {
    process.stderr.write("Capture shutdown exceeded its deadline\n");
    bridge?.dispose();
    app.exit(1);
  }, 10_000);
  let report;
  try {
    if (!store && config?.assignments) {
      store = new CaptureStore(config, { backend: "browser-webgpu", initialization_failed: true });
    }
    if (capture) report = error ? await capture.abort(error) : await capture.done();
    else if (store) {
      report = {
        runId: config.runId,
        status: "failed",
        error: error?.stack ?? "Capture initialization failed",
        cases: config.assignments.map((entry) => ({ id: entry.case.id, status: "skipped" })),
      };
      await store.finish(report);
    }
  } catch (failure) {
    process.stderr.write(`${failure.stack ?? failure}\n`);
    error = failure;
  }
  bridge?.dispose();
  window?.destroy();
  log?.end();
  await logCompletion;
  clearTimeout(shutdownTimer);
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
    if (!process.env.ASTER_PARITY_CONFIG)
      throw new Error("ASTER_PARITY_CONFIG must address a capture run configuration");
    config = JSON.parse(readFileSync(process.env.ASTER_PARITY_CONFIG, "utf8"));
    if (!Array.isArray(config.assignments) || !config.root || !config.runDirectory || !config.url) {
      throw new Error("Invalid parity capture configuration");
    }
    mkdirSync(config.runDirectory, { recursive: true });
    log = createWriteStream(join(config.runDirectory, "electron.log"), { flags: "a" });
    logCompletion = finished(log).catch(() => {});
    log.on("error", (error) => {
      log = undefined;
      void stop(error);
    });
    const writeLog = (kind, value) =>
      log?.write(`${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`);
    protocol.registerSchemesAsPrivileged([assets.ASSET_SCHEME_REGISTRATION]);
    const profile = join(config.runDirectory, "profile");
    mkdirSync(profile, { recursive: true });
    app.setPath("userData", profile);
    app.commandLine.appendSwitch("force_high_performance_gpu");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    writeLog("startup", "Waiting for Electron readiness");
    startupTimer = setTimeout(() => {
      void stop(new Error("Electron application startup timed out"));
    }, config.timeoutMs ?? 300_000);
    await app.whenReady();
    if (stopping) return;
    writeLog("startup", "Electron ready; requesting GPU information");
    const gpuInfo = await app.getGPUInfo("complete");
    const host = captureHostInfo(gpuInfo, app.getGPUFeatureStatus());
    store = new CaptureStore(config, host);
    const allowedAssets = new Map();
    protocol.handle(
      assets.ASSET_SCHEME,
      assets.createAssetProtocolHandler({ allowedAssets, fetchFile: files.fetchLocalAsset }),
    );
    const suffix = process.platform === "win32" ? ".exe" : "";
    bridge = new DesktopBridgeClient(
      join(config.root, "target", "release", `aster-desktop-bridge${suffix}`),
      profile,
      {
        timeoutMs: config.timeoutMs,
        log: (line) => writeLog("bridge", line),
        env: {
          ASTER_FFMPEG_PATH:
            process.env.ASTER_FFMPEG_PATH ??
            join(config.root, "build", "ffmpeg", `ffmpeg${suffix}`),
          ASTER_FFPROBE_PATH:
            process.env.ASTER_FFPROBE_PATH ??
            join(config.root, "build", "ffmpeg", `ffprobe${suffix}`),
        },
      },
    );
    const access = new CaptureDesktopAccess(config, bridge, allowedAssets);
    capture = new CaptureSession(config, host, store, access, {
      recover: launchWindow,
      fatal: stop,
    });
    const waitForProgress = (message) => {
      clearTimeout(startupTimer);
      if (stopping) return;
      startupTimer = setTimeout(() => {
        void stop(new Error(message));
      }, config.timeoutMs ?? 300_000);
    };
    const requireSender = (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new Error("Capture IPC sender is not the active main frame");
      }
    };
    const handle = (name, callback) =>
      ipcMain.handle(`aster:parity-${name}`, async (event, ...args) => {
        requireSender(event);
        return callback(...args);
      });
    handle("desktop", (command, args) => access.invoke(command, args));
    handle("preferences", () => preferences.defaultAppPreferences());
    handle("gpu-memory", () => gpuMemory.detectGpuMemoryDevices());
    handle("ready", (identity) => capture.ready(identity));
    handle("take", async () => {
      clearTimeout(startupTimer);
      const assignment = await capture.take();
      if (!assignment) waitForProgress("Capture finalization timed out");
      return assignment;
    });
    handle("frame", (payload) => capture.frame(payload));
    handle("complete", async (payload) => {
      await capture.completeCase(payload);
      waitForProgress("Renderer did not continue after completing its case");
    });
    handle("fail", async (payload) => {
      if (!payload?.caseId) {
        void stop(new Error(payload?.error ?? "Capture renderer failed"));
        return;
      }
      await capture.fail(payload);
      waitForProgress("Renderer did not continue after failing its case");
    });
    handle("done", async () => {
      const report = await capture.done();
      setTimeout(() => {
        void stop();
      }, 100);
      return report;
    });
    ipcMain.on("aster:parity-log", (event, entry) => {
      try {
        requireSender(event);
        writeLog("renderer", entry);
        const error = capture.log(entry);
        if (error) void stop(error);
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
      if (details.type === "GPU" && !stopping) {
        void capture.rendererLost(new Error(`GPU process exited: ${details.reason}`)).catch(stop);
      }
    });

    async function launchWindow() {
      if (stopping) return;
      const previous = window;
      window = undefined;
      previous?.destroy();
      const next = new BrowserWindow({
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
      window = next;
      next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      next.webContents.on("will-navigate", (event, url) => {
        if (url !== config.url) event.preventDefault();
      });
      next.webContents.on("console-message", (details) => {
        writeLog("console", {
          level: details.level,
          message: details.message,
          lineNumber: details.lineNumber,
          sourceId: details.sourceId,
        });
      });
      next.webContents.on("render-process-gone", (_event, details) => {
        if (window === next && !stopping) {
          void capture
            .rendererLost(new Error(`Capture renderer exited: ${details.reason}`))
            .catch(stop);
        }
      });
      clearTimeout(startupTimer);
      startupTimer = setTimeout(() => {
        void stop(new Error("Capture renderer startup timed out"));
      }, config.timeoutMs ?? 300_000);
      await next.loadURL(config.url);
    }
    await launchWindow();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    await stop(error);
  }
}

void main();
