import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { encodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_PREVIEW_CORPUS_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
const report = {
  status: "failed",
  scope: "native-project-production-preview-canvas",
  frames: [],
  cases: [],
};
let window, client, broker, timer, current;
let index = 0,
  sampleIndex = 0,
  finishing = false;

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  try {
    if (error) throw error;
    assert.equal(index, config.jobs.length);
    assert.equal(sampleIndex, current.samples.length);
    await broker.close();
    report.all_references_released = true;
    report.status = "passed";
  } catch (failure) {
    report.error = String(failure.stack ?? failure);
    client?.abort("Preview corpus failed");
  }
  await writeAtomicJson(join(config.output, "report.json"), report);
  window?.destroy();
  app.exit(report.status === "passed" ? 0 : 1);
}

async function main() {
  try {
    await app.whenReady();
    const { NativePreviewClient } = await import(
      pathToFileURL(join(config.root, "dist-electron/electron/native-preview-client.js"))
    );
    const { NativePreviewBroker } = await import(
      pathToFileURL(join(config.root, "dist-electron/electron/native-preview-broker.js"))
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        preload: join(config.root, "dist-electron/electron/preload.cjs"),
      },
    });
    const trusted = (event) =>
      assert(
        event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
      );
    ipcMain.handle("aster:native-preview-present", (event, id, time, request) => {
      trusted(event);
      assert.equal(id, "corpus");
      assert.equal(time, current.samples[sampleIndex].time);
      return broker.present(event.senderFrame, { id, request }, time);
    });
    ipcMain.handle("aster:invoke", async (event, command, args) => {
      trusted(event);
      if (command === "preview_corpus_next") {
        if (current) assert.equal(sampleIndex, current.samples.length);
        if (index === config.jobs.length) return null;
        current = config.jobs[index++];
        sampleIndex = 0;
        if (!client) {
          client = new NativePreviewClient({
            executable: config.binary,
            cwd: config.root,
            args: [
              "preview-project",
              "--project",
              current.project,
              "--request",
              current.request,
              "--slots",
              "2",
              "--dxcompiler",
              config.compiler,
              "--ffmpeg",
              join(config.root, "build/ffmpeg/ffmpeg.exe"),
              "--ffprobe",
              join(config.root, "build/ffmpeg/ffprobe.exe"),
            ],
          });
          broker = new NativePreviewBroker(client);
          await client.ready;
        } else await broker.replace(current.project, current.request);
        const ready = client.current;
        assert.equal(ready.source.kind, "project");
        assert.equal(ready.source.authored_sha256, current.project_sha256);
        assert.equal(ready.source.scope, current.scope);
        assert.equal(ready.source.composition_id, current.composition);
        assert.deepEqual({ width: ready.width, height: ready.height }, current.size);
        report.cases.push({ id: current.id, ready });
        return { id: current.id, ready, samples: current.samples };
      }
      if (command === "preview_corpus_frame") {
        const sample = current.samples[sampleIndex];
        assert.equal(args.id, current.id);
        assert.equal(args.frame, sample.frame);
        assert.equal(args.time, sample.time);
        assert.deepEqual(args.ready, client.current);
        assert.deepEqual({ width: args.width, height: args.height }, current.size);
        const pixels = Buffer.from(args.pixels);
        assert.equal(pixels.length, args.width * args.height * 4);
        assert(["rgba", "bgra"].includes(args.pixelFormat));
        if (args.pixelFormat === "bgra")
          for (let i = 0; i < pixels.length; i += 4)
            [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
        const directory = join(config.output, "frames", current.id);
        await mkdir(directory, { recursive: true });
        const png = encodeRgbaPng(args.width, args.height, pixels);
        const path = `frames/${current.id}/${sample.frame}.png`;
        await writeFile(join(config.output, path), png, { flag: "wx" });
        report.frames.push({
          case_id: current.id,
          frame: sample.frame,
          time: sample.time,
          path,
          png_sha256: sha256(png),
          rgba_sha256: sha256(pixels),
          generation: client.current.generation,
        });
        sampleIndex++;
        if (sampleIndex === current.samples.length) {
          await writeAtomicJson(join(config.output, "report.json"), report);
          console.log(`${current.id}: ${sampleIndex} preview frames`);
        }
        return;
      }
      if (command === "preview_corpus_done") {
        setImmediate(() => void finish());
        return;
      }
      if (command === "preview_corpus_error") {
        setImmediate(() => void finish(new Error(args.error)));
        return;
      }
      throw new Error("Unknown corpus command");
    });
    window.webContents.on(
      "render-process-gone",
      (_event, details) => void finish(new Error(`Corpus renderer exited: ${details.reason}`)),
    );
    timer = setTimeout(() => void finish(new Error("Preview corpus timed out")), 3600000);
    await window.loadFile(config.html);
  } catch (error) {
    await finish(error);
  }
}
void main();
