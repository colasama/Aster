import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import * as assets from "../../dist-electron/electron/asset-protocol.js";
import * as files from "../../dist-electron/electron/local-file-response.js";
import { CaptureDesktopAccess, DesktopBridgeClient } from "../parity/desktop-bridge.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

async function main() {
  const config = JSON.parse(readFileSync(process.env.ASTER_NATIVE_RASTER_CONFIG, "utf8"));
  let bridge,
    window,
    current,
    timer,
    stopping = false;
  let assignmentIndex = 0,
    sampleIndex = 0,
    prepared;
  const report = { status: "running", scope: "fresh-retained-raster-acquisition", frames: [] };
  async function stop(error) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    report.status = error ? "failed" : "passed";
    if (error) report.error = error.stack ?? String(error);
    try {
      await writeAtomicJson(join(config.output, "capture.json"), report);
    } finally {
      bridge?.dispose();
      window?.destroy();
      app.exit(error ? 1 : 0);
    }
  }
  process.on("uncaughtException", stop);
  process.on("unhandledRejection", stop);
  protocol.registerSchemesAsPrivileged([assets.ASSET_SCHEME_REGISTRATION]);
  mkdirSync(join(config.output, "profile"), { recursive: true });
  app.setPath("userData", join(config.output, "profile"));
  for (const flag of [
    "force_high_performance_gpu",
    "disable-background-timer-throttling",
    "disable-renderer-backgrounding",
    "disable-backgrounding-occluded-windows",
  ])
    app.commandLine.appendSwitch(flag);
  process.stdout.write("Raster host waiting for Electron readiness\n");
  await app.whenReady();
  process.stdout.write("Raster host ready\n");
  const allowedAssets = new Map();
  protocol.handle(
    assets.ASSET_SCHEME,
    assets.createAssetProtocolHandler({ allowedAssets, fetchFile: files.fetchLocalAsset }),
  );
  bridge = new DesktopBridgeClient(
    join(config.root, "target/release/aster-desktop-bridge.exe"),
    join(config.output, "profile"),
  );
  const access = new CaptureDesktopAccess(config, bridge, allowedAssets);
  const resetDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new Error("Native raster resource request timed out")), 300000);
  };
  const handle = (name, callback) =>
    ipcMain.handle(`aster:raster-${name}`, async (event, ...args) => {
      assert(
        event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame,
      );
      resetDeadline();
      return callback(...args);
    });
  handle("desktop", (command, args) => access.invoke(command, args));
  handle("ready", (value) => {
    report.host = value;
  });
  handle("take", async () => {
    assert(!current || sampleIndex === current.samples.length);
    current = config.assignments[assignmentIndex++];
    sampleIndex = 0;
    if (!current) return null;
    await access.prepare(current);
    process.stdout.write(`Raster case: ${current.case.id}\n`);
    return { id: current.case.id, projectPath: current.projectPath, samples: current.samples };
  });
  handle("prepare", async (value) => {
    const sample = current?.samples[sampleIndex];
    assert(sample && !prepared && value.caseId === current.case.id && value.index === sample.index);
    const directory = join(config.output, current.case.id, String(sample.index));
    await mkdir(directory, { recursive: true });
    const request = config.orderedResources
      ? {
          frame: {
            compositionId: current.case.composition,
            time: sample.time,
            snapshotScope: sample.header.snapshot_scope,
            projectRevision: sample.header.project_revision,
            target: sample.header.target,
            renderTarget: sample.header.render_target,
            antiAliasing: sample.header.aa,
            shadowsEnabled: true,
          },
          context: {
            visualization: "beauty",
            locale: value.locale,
            layouts: value.layouts,
            surface: {
              revision: 1,
              maxTextureDimension: 4096,
              memoryBudgetMb: 512,
              renderScale: 1,
            },
            maximumRasterDimension: value.maximumDimension,
            maximumRasterPixels: 67108864,
          },
        }
      : {
          compositionId: current.case.composition,
          time: sample.time,
          locale: value.locale,
          layouts: value.layouts,
          context: {
            resolutionScale: current.resolutionScale,
            maximumDimension: value.maximumDimension,
            maximumPixels: 67108864,
          },
        };
    const requestPath = join(directory, "request.json");
    await writeAtomicJson(requestPath, request);
    const result = await promisify(execFile)(
      config.cli,
      [
        config.orderedResources ? "prepare-resources" : "prepare-rasters",
        "--project",
        current.projectPath,
        "--request",
        requestPath,
      ],
      { cwd: config.root, windowsHide: true, maxBuffer: 67108864, timeout: 120000 },
    );
    const native = JSON.parse(result.stdout);
    assert.equal(
      native.kind,
      config.orderedResources
        ? "native-project-resource-requests"
        : "native-retained-raster-requests",
    );
    assert.equal(native.projectSha256, current.project_sha256);
    assert.equal(native.requestSha256, sha256(await readFile(requestPath)));
    await writeAtomicJson(join(directory, "native-requests.json"), native);
    prepared = { directory, native };
    return {
      requests: config.orderedResources
        ? native.preparation.operations.filter((op) => op.kind === "raster").map((op) => op.request)
        : native.requests,
    };
  });
  handle("frame", async (value) => {
    const sample = current?.samples[sampleIndex];
    assert(prepared && sample && value.caseId === current.case.id && value.index === sample.index);
    assert(Array.isArray(value.pixels) && value.pixels.length <= 65536);
    const pixels = [];
    const written = new Map();
    let total = 0;
    for (const item of value.pixels) {
      assert(
        /^[a-f0-9]{64}$/.test(item.frame.hash) && /^[a-f0-9]{64}$/.test(item.pixels.message.hash),
      );
      const bytes = Buffer.from(item.pixels.bytes);
      total += bytes.length;
      assert(total <= 67108864);
      const file = `${item.pixels.message.hash}.bin`;
      if (written.has(file)) assert.equal(written.get(file), sha256(bytes));
      else {
        await writeFile(join(prepared.directory, file), bytes, { flag: "wx" });
        written.set(file, sha256(bytes));
      }
      pixels.push({ frame: item.frame, message: item.pixels.message, file, sha256: sha256(bytes) });
    }
    const observation = {
      ...value,
      pixels,
      ...(config.orderedResources ? { requestSha256: prepared.native.preparationSha256 } : {}),
    };
    await writeAtomicJson(join(prepared.directory, "rasters.json"), observation);
    report.frames.push({ case: current.case.id, index: sample.index, rasters: pixels.length });
    await writeAtomicJson(join(config.output, "capture.json"), report);
    prepared = undefined;
    sampleIndex++;
  });
  handle("done", () => {
    assert(assignmentIndex > config.assignments.length && !current && !prepared);
    setTimeout(() => stop(), 10);
  });
  handle("fail", (error) => {
    void stop(new Error(error));
  });
  ipcMain.on("aster:raster-log", (event, entry) => {
    if (event.sender === window?.webContents && entry?.level === "error")
      void stop(new Error(JSON.stringify(entry)));
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) => contents === window?.webContents && permission === "local-fonts",
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(contents === window?.webContents && permission === "local-fonts"),
  );
  window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    width: 64,
    height: 64,
    webPreferences: {
      preload: resolve(import.meta.dirname, "native-raster-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (details) =>
    process.stderr.write(`${details.level}: ${details.message}\n`),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== config.url) event.preventDefault();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void stop(new Error(`Raster renderer exited: ${details.reason}`));
  });
  app.on("window-all-closed", () => {});
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU" && !stopping)
      void stop(new Error(`Raster GPU exited: ${details.reason}`));
  });
  resetDeadline();
  await window.loadURL(config.url);
}
void main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
