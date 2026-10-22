import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { decodeRgbaPng, encodeRgbaPng } from "../parity/png.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_SHARED_PREVIEW_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
const report = { status: "failed", scope: "shared-bgra-transport", frames: [] };
let window;
let client;
let broker;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const onceIpc = (channel) =>
  new Promise((resolve, reject) => {
    const listener = (event, data) => {
      if (event.sender !== window.webContents) return;
      clearTimeout(timer);
      ipcMain.removeListener(channel, listener);
      resolve(data);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, listener);
      reject(new Error(`${channel} timed out`));
    }, 30000);
    ipcMain.on(channel, listener);
  });

async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(config.root, "scripts/migration/shared-preview-preload.cjs"),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
        paintWhenInitiallyHidden: true,
      },
    });
    const receiverReady = onceIpc("preview-witness-ready");
    await window.loadFile(join(config.root, "scripts/migration/shared-preview.html"));
    await receiverReady;
    ipcMain.on("preview-witness-error", (_event, message) => {
      report.renderer_error = message;
    });
    const { NativePreviewClient } = await import(
      pathToFileURL(join(config.root, "dist-electron/electron/native-preview-client.js"))
    );
    client = new NativePreviewClient({
      executable: config.binary,
      cwd: config.root,
      args: [
        ...(config.project
          ? [
              "preview-project",
              "--project",
              config.project,
              "--request",
              config.request,
              "--ffmpeg",
              join(config.root, "build/ffmpeg/ffmpeg.exe"),
              "--ffprobe",
              join(config.root, "build/ffmpeg/ffprobe.exe"),
            ]
          : ["preview-plan", "--plan", config.plan, "--resources", config.resources]),
        "--slots",
        "2",
        "--dxcompiler",
        config.compiler,
      ],
    });
    const { NativePreviewBroker } = await import(
      pathToFileURL(join(config.root, "dist-electron/electron/native-preview-broker.js"))
    );
    broker = new NativePreviewBroker(client);
    let ready = await client.ready;
    assert.equal(ready.type, "ready", JSON.stringify(ready));
    report.ready = ready;
    if (config.project) {
      assert.equal(ready.source.kind, "project");
      assert.equal(ready.source.authored_sha256, hash(readFileSync(config.project)));
    } else assert.equal(ready.source.kind, "plan");
    const samples =
      config.samples ?? Array.from({ length: 12 }, () => ({ reference: config.reference }));
    for (const [index, sample] of samples.entries()) {
      if (sample.replace) {
        const previous = ready;
        await broker.replace(sample.replace.project, sample.replace.request);
        ready = client.current;
        assert.equal(ready.generation, previous.generation + 1);
        assert.equal(ready.source.authored_sha256, hash(readFileSync(sample.replace.project)));
        const requested = JSON.parse(readFileSync(sample.replace.request, "utf8"));
        assert.equal(ready.source.scope, requested.frame.snapshotScope);
        assert.equal(ready.source.revision, requested.frame.projectRevision);
        assert.equal(ready.source.composition_id, requested.frame.compositionId);
        report.replacements ??= [];
        report.replacements.push({ before: previous, after: ready });
      }
      const sequence = index + 1;
      const expected = decodeRgbaPng(readFileSync(sample.reference));
      assert.equal(ready.width, expected.width);
      assert.equal(ready.height, expected.height);
      const pixelsReady = onceIpc("preview-witness-frame");
      const reply = await broker.present(
        window.webContents.mainFrame,
        { witness: true },
        sample.time,
      );
      assert.equal(reply.sequence, sequence);
      const result = await pixelsReady;
      assert.equal(result.sequence, sequence);
      assert.equal(result.generation, ready.generation);
      assert.equal(result.time, sample.time ?? null);
      assert.deepEqual(result.source, ready.source);
      assert.equal(result.timestamp, sequence);
      const pixels = Buffer.from(result.pixels, "base64");
      const path = join(config.output, `frame-${sequence}.png`);
      await writeFile(path, encodeRgbaPng(ready.width, ready.height, pixels), { flag: "wx" });
      const actualHash = hash(pixels);
      const expectedHash = hash(expected.pixels);
      report.frames.push({
        sequence,
        generation: ready.generation,
        source: ready.source,
        time: sample.time ?? null,
        path,
        rgba_sha256: actualHash,
        expected_rgba_sha256: expectedHash,
        exact: actualHash === expectedHash,
        render_and_share_ms: reply.render_and_share_ms,
        video_format: result.format,
      });
      assert.equal(actualHash, expectedHash, "Shared GPU canvas pixels differ");
    }
    const unavailable = new BrowserWindow({ show: false });
    try {
      await unavailable.loadFile(join(config.root, "scripts/migration/shared-preview.html"));
      await assert.rejects(
        broker.present(unavailable.webContents.mainFrame, { witness: true }, samples[0].time),
      );
      report.unregistered_receiver_rejected = true;
    } finally {
      unavailable.destroy();
    }
    await broker.close();
    report.all_references_released = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    if (report.status !== "passed") client?.abort("Shared preview witness failed");
    await writeAtomicJson(join(config.output, "report.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
