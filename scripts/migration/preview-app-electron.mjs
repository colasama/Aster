import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { decodeRgbaPng, encodeRgbaPng } from "../parity/png.mjs";
import { captureNativePreviewProcesses } from "./preview-process-witness.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_PREVIEW_APP_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const report = {
  status: "failed",
  scope: "application-preview-host-and-sandboxed-canvas",
  frames: [],
  snapshots: [],
  rounds: [],
  producer_crashes: [],
};
let window, host, timer;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function save(directory, document) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.bridge, ["--app-data-dir", join(config.output, "bridge-profile")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let bytes = Buffer.alloc(0),
      error = "",
      accepted = false;
    child.stdout.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1048576) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const reply = JSON.parse(bytes.toString().trim());
        assert.equal(code, 0, error);
        assert.equal(reply.id, 1);
        assert(!reply.error, JSON.stringify(reply.error));
        accepted = true;
        resolve();
      } catch (failure) {
        reject(failure);
      }
    });
    child.stdin.end(
      `${JSON.stringify({
        id: 1,
        command: "save_project",
        args: { path: directory, project: document },
      })}\n`,
    );
    const timeout = setTimeout(() => {
      if (!accepted) child.kill();
    }, 120000);
    timeout.unref();
    child.once("close", () => clearTimeout(timeout));
  });
}
async function finish(error) {
  clearTimeout(timer);
  if (error) report.error = String(error.stack ?? error);
  try {
    await host?.dispose();
    report.remaining_private_sessions = (await readdir(join(config.output, "private"))).length;
    assert.equal(report.remaining_private_sessions, 0);
  } catch (failure) {
    report.error ??= String(failure);
  }
  if (!report.error) report.status = "passed";
  await writeAtomicJson(join(config.output, "report.json"), report);
  window?.destroy();
  app.exit(report.status === "passed" ? 0 : 1);
}
async function main() {
  try {
    await app.whenReady();
    const { NativePreviewHost } = await import(
      pathToFileURL(join(config.root, "dist-electron/electron/native-preview-host.js"))
    );
    window = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        preload: join(config.root, "dist-electron/electron/preload.cjs"),
      },
    });
    host = new NativePreviewHost({
      enabled: true,
      temporaryRoot: join(config.output, "private"),
      binary: config.binary,
      compiler: config.compiler,
      ffmpeg: join(config.root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe: join(config.root, "build/ffmpeg/ffprobe.exe"),
      raster: {
        executable: process.execPath,
        host: join(config.root, "dist-electron/electron/native-raster-host.js"),
        bundle: join(config.root, "dist/native-raster/native-raster.html"),
        bridge: config.bridge,
      },
      trusted: (contents) => contents === window.webContents,
      save,
    });
    host.registerIpc();
    ipcMain.handle("aster:invoke", async (event, command, args) => {
      assert.equal(event.sender, window.webContents);
      if (command === "preview_witness_open")
        return {
          snapshots: config.snapshots,
          times: config.times,
          restart: report.rounds.length === 0,
        };
      if (command === "preview_witness_frame" || command === "preview_witness_snapshot") {
        const snapshot = command === "preview_witness_snapshot";
        const collection = snapshot ? report.snapshots : report.frames;
        const reference = decodeRgbaPng(readFileSync(config.references[args.generation]));
        const pixels = Buffer.from(args.pixels);
        assert.equal(args.width, reference.width);
        assert.equal(args.height, reference.height);
        if (args.pixelFormat === "bgra")
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            pixels[i] = pixels[i + 2];
            pixels[i + 2] = r;
          }
        if (snapshot) {
          // The editor presents associated RGB on an opaque canvas; transport readbacks retain alpha.
          await writeFile(
            join(config.output, `snapshot-${collection.length}-straight.png`),
            encodeRgbaPng(args.width, args.height, pixels),
            { flag: "wx" },
          );
          for (let i = 0; i < pixels.length; i += 4) {
            assert.equal(pixels[i + 3], 255, "Editor snapshot must be opaque");
            reference.pixels[i + 3] = 255;
          }
        }
        const path = join(
          config.output,
          `${snapshot ? "snapshot" : "frame"}-${collection.length}.png`,
        );
        await writeFile(path, encodeRgbaPng(args.width, args.height, pixels), { flag: "wx" });
        const actual = hash(pixels),
          expected = hash(reference.pixels);
        collection.push({
          generation: args.generation,
          time: args.time,
          ready: args.ready,
          path,
          rgba_sha256: actual,
          expected_rgba_sha256: expected,
          exact: actual === expected,
          ...(snapshot
            ? { normalization: "reference-associated-rgb-to-opaque-editor-canvas" }
            : {}),
        });
        assert.equal(actual, expected, "Application preview pixels differ");
        return;
      }
      if (command === "preview_witness_lifecycle") {
        report.lifecycle = args;
        return;
      }
      if (command === "preview_witness_crash_producer") {
        const owned = await captureNativePreviewProcesses(config.binary, process.pid);
        assert.equal(owned.producers.length, 1, "Crash fixture must own exactly one producer");
        const producer = owned.producers[0];
        assert.equal(producer.parent_process_id, process.pid);
        process.kill(producer.process_id);
        report.producer_crashes.push(owned);
        return;
      }
      if (command === "preview_witness_done") {
        report.rounds.push(report.lifecycle);
        if (report.rounds.length === 1) {
          setImmediate(
            () =>
              void (async () => {
                let timeout;
                try {
                  const gone = new Promise((resolve, reject) => {
                    timeout = setTimeout(
                      () => reject(new Error("Renderer crash was not observed")),
                      10000,
                    );
                    window.webContents.once("render-process-gone", (_event, details) =>
                      resolve(details),
                    );
                  });
                  const live = await captureNativePreviewProcesses(config.binary, process.pid);
                  assert.equal(live.producers.length, 1);
                  window.webContents.forcefullyCrashRenderer();
                  report.renderer_restart = { crash: await gone, live_producer: live };
                  // Observe crash-triggered retirement; disposing the application host is terminal.
                  const retirementStarted = Date.now();
                  while ((await readdir(join(config.output, "private"))).length > 0) {
                    assert(
                      Date.now() - retirementStarted < 30000,
                      "Crashed renderer's preview sessions were not retired",
                    );
                    await delay(50);
                  }
                  report.renderer_restart.old_sessions_released = true;
                  await window.loadFile(config.html);
                } catch (error) {
                  await finish(error);
                } finally {
                  clearTimeout(timeout);
                }
              })(),
          );
          return;
        }
        assert.equal(report.rounds.length, 2);
        report.renderer_restart.reloaded = true;
        report.clean_close = true;
        setImmediate(() => void finish());
        return;
      }
      if (command === "preview_witness_error") {
        setImmediate(() => void finish(new Error(args.message)));
        return;
      }
      throw new Error("Unexpected witness command");
    });
    timer = setTimeout(
      () => void finish(new Error("Preview application witness timed out")),
      180000,
    );
    await window.loadFile(config.html);
  } catch (error) {
    await finish(error);
  }
}
void main();
