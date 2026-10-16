import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { withQueueAudio } from "./native-queue-fixture.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_NATIVE_QUEUE_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
app.on("window-all-closed", () => {});
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("console-message", (_e, _l, message) => console.log("renderer:", message));
  window.webContents.on("preload-error", (_e, path, error) => console.log("preload:", path, error));
});

async function main() {
  const { root, output, appPath, packagedDirectory } = config;
  const load = (name) => import(pathToFileURL(join(appPath, `dist-electron/electron/${name}.js`)));
  const { ElectronRenderHostController } = await load("render-queue-host");
  const { RenderQueueStore } = await load("render-queue-store");
  const { RenderQueueManager } = await load("render-queue-manager");
  const { AsterLogger } = await load("logger");
  const { nativeRenderRuntime } = await load("native-render-runtime");
  const { defaultAppPreferences } = await import(
    pathToFileURL(join(appPath, "dist-electron/src/desktop/preferences.js"))
  );
  const report = {
    status: "failed",
    native_export_acceptance: false,
    source: config.source,
    capture: { path: config.capture, sha256: config.capture_sha256 },
    app_path: appPath,
    jobs: [],
    routes: [],
    errors: [],
  };
  let manager, controller, logger;
  try {
    await app.whenReady();
    ipcMain.handle("aster:preferences-get", () => defaultAppPreferences());
    ipcMain.handle("aster:gpu-memory-devices", () => []);
    ipcMain.on("aster:log", (_e, entry) => {
      if (entry.level === "error") report.errors.push(entry);
    });
    logger = new AsterLogger({ directory: join(output, "logs"), level: "debug" });
    await logger.initialize();
    const info = logger.info.bind(logger);
    logger.info = (scope, event, data) => {
      if (event === "native_export_route") report.routes.push(data);
      info(scope, event, data);
    };
    assert.equal(await hashFile(config.capture), config.capture_sha256);
    const input = JSON.parse(await readFile(config.capture, "utf8"));
    assert.equal(input.status, "passed");
    const source = input.frames.find((frame) => frame.mode === "recursive").job;
    assert(source);
    const queueRoot = join(output, "queue");
    await mkdir(queueRoot);
    const store = new RenderQueueStore(queueRoot);
    await store.initialize();
    const ffmpeg = packagedDirectory
      ? join(packagedDirectory, "resources/bin/ffmpeg.exe")
      : join(root, "build/ffmpeg/ffmpeg.exe");
    const runtime = nativeRenderRuntime({
      appPath,
      resourcesPath: join(packagedDirectory ?? root, "resources"),
      packaged: !!packagedDirectory,
      executable: packagedDirectory ? join(packagedDirectory, "Aster.exe") : process.execPath,
      temporaryDirectory: output,
      ffmpeg,
    });
    assert(runtime);
    report.runtime = {};
    for (const key of ["binary", "compiler", "ffprobe"])
      report.runtime[key] = { path: runtime[key], sha256: await hashFile(runtime[key]) };
    const options = {
      appPath,
      developmentUrl: "http://127.0.0.1:1420",
      packaged: true,
      ffmpegExecutable: ffmpeg,
      logger,
      nativeRuntime: runtime,
    };
    let selected, terminal, action, threshold, resumed, requested, pauseCheck, paused;
    let destination, sentinelHash;
    const states = [];
    const commandErrors = [];
    const command = (type) =>
      manager.command({ type, jobId: selected }).catch((error) => {
        commandErrors.push(String(error));
      });
    manager = new RenderQueueManager(
      store,
      (state) => {
        const item = state.items.find((x) => x.manifest.id === selected);
        if (!item) return;
        states.push({ status: item.status, frames: item.progress.completedFrames });
        if (
          item.status === "rendering" &&
          item.progress.completedFrames >= threshold &&
          !requested &&
          action
        ) {
          requested = true;
          queueMicrotask(() => void command(action));
        }
        if (item.status === "paused" && !resumed) {
          resumed = true;
          pauseCheck = (async () => {
            const before = item.progress.completedFrames;
            assert.equal(await hashFile(destination), sentinelHash);
            await delay(150);
            const last = states.at(-1);
            assert.equal(last.status, "paused");
            assert.equal(last.frames, before, "Paused job advanced");
            assert.equal(await hashFile(destination), sentinelHash);
            paused = {
              frames_before: before,
              frames_after: last.frames,
              destination_sha256: sentinelHash,
            };
            await command("resume");
          })().catch((error) => commandErrors.push(String(error)));
        }
        if (["completed", "failed", "cancelled"].includes(item.status)) terminal?.(item);
      },
      undefined,
      (error) => commandErrors.push(String(error)),
    );
    controller = new ElectronRenderHostController(options);
    controller.registerIpc();
    await manager.startScheduler(controller, 1);
    const run = (file, args) =>
      new Promise((done, reject) =>
        execFile(
          file,
          args,
          { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}: ${stderr}`)) : done(stdout),
        ),
      );
    for (const scenario of [
      "complete",
      "audio",
      "pause-export",
      "cancel-preflight",
      "cancel-export",
      "fallback",
    ]) {
      selected = `native-queue-${scenario}`;
      action = scenario.startsWith("cancel")
        ? "cancel"
        : scenario.startsWith("pause")
          ? "pause"
          : undefined;
      threshold = scenario.endsWith("export") ? 1 : 0;
      requested = false;
      resumed = false;
      pauseCheck = undefined;
      paused = undefined;
      states.length = 0;
      options.nativeRuntime =
        scenario === "fallback"
          ? { ...runtime, binary: join(output, "unavailable-renderer.exe") }
          : runtime;
      let manifest = structuredClone(source);
      manifest.id = selected;
      const frameCount = scenario === "pause-export" ? 120 : 12;
      manifest.endFrameExclusive = manifest.startFrame + frameCount;
      if (scenario === "audio") manifest = withQueueAudio(manifest);
      const jobDirectory = join(output, scenario);
      await mkdir(jobDirectory);
      manifest.outputs[0].destination = join(jobDirectory, "output.mp4");
      const sentinel = Buffer.from("previous destination");
      await writeFile(manifest.outputs[0].destination, sentinel, { flag: "wx" });
      destination = manifest.outputs[0].destination;
      sentinelHash = await hashFile(destination);
      let timeout;
      const completed = new Promise((done, reject) => {
        terminal = done;
        timeout = setTimeout(() => reject(new Error(`Queue ${scenario} timed out`)), 120000);
      });
      let item;
      try {
        await manager.enqueue(manifest);
        item = await completed;
      } finally {
        clearTimeout(timeout);
        terminal = undefined;
      }
      assert.equal(
        item.status,
        action === "cancel" ? "cancelled" : "completed",
        JSON.stringify(item.error),
      );
      for (let i = 0; i < 100 && manager.activeHostCount; i++) await delay(50);
      assert.equal(manager.activeHostCount, 0);
      await pauseCheck;
      assert.deepEqual(commandErrors, []);
      const route = report.routes.find((r) => r.jobId === selected);
      const evidence = {
        scenario,
        frame_count: frameCount,
        status: item.status,
        progress: item.progress,
        states: [...states],
        route,
        paused,
      };
      if (action === "cancel") {
        assert.deepEqual(await readFile(manifest.outputs[0].destination), sentinel);
        if (threshold) {
          assert(item.progress.completedFrames >= 1 && item.progress.completedFrames < frameCount);
          assert.equal(route?.renderer, "rust");
        }
      } else {
        assert.equal(item.progress.completedFrames, frameCount);
        assert.equal(
          route?.renderer,
          scenario === "fallback" ? "ts" : "rust",
          JSON.stringify(route),
        );
        if (scenario === "fallback") assert.match(route.reason, /ENOENT|unavailable-renderer/);
        const probe = JSON.parse(
          await run(runtime.ffprobe, [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            manifest.outputs[0].destination,
          ]),
        );
        const video = probe.streams.find((s) => s.codec_type === "video");
        assert.equal(Number(video.nb_read_frames), frameCount);
        assert.equal(video.codec_name, "h264");
        assert.equal(video.width, manifest.width);
        assert.equal(video.height, manifest.height);
        assert(Math.abs(Number(video.duration) - frameCount / 30) < 1 / 30);
        if (scenario === "audio") {
          const audio = probe.streams.find((s) => s.codec_type === "audio");
          assert(audio);
          assert.equal(Number(audio.sample_rate), 48000);
          assert.equal(audio.channels, 2);
          assert(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.04);
          const pcm = await run(ffmpeg, [
            "-v",
            "error",
            "-i",
            manifest.outputs[0].destination,
            "-map",
            "0:a",
            "-f",
            "f32le",
            "pipe:1",
          ]);
          let energy = 0;
          for (let i = 0; i < pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
          evidence.audio_rms = Math.sqrt(energy / (pcm.length / 4));
          assert(evidence.audio_rms > 0.05);
        }
        evidence.probe = probe;
      }
      if (action === "pause") {
        assert(
          paused.frames_before >= 1 && paused.frames_before < frameCount,
          "Pause must interrupt an unfinished frame sequence",
        );
        assert(states.some((s) => s.status === "paused" && s.frames === paused.frames_before));
      }
      assert.deepEqual(await readdir(jobDirectory), ["output.mp4"]);
      assert.deepEqual(await readdir(runtime.temporaryRoot), []);
      evidence.files = {
        destination,
        destination_sha256: await hashFile(destination),
        previous_sha256: sentinelHash,
        directory: jobDirectory,
        entries: await readdir(jobDirectory),
        temporary_root: runtime.temporaryRoot,
        temporary_entries: await readdir(runtime.temporaryRoot),
        active_hosts: manager.activeHostCount,
      };
      report.jobs.push(evidence);
      console.log(`queue: ${scenario} passed`);
    }
    const persisted = JSON.parse(await readFile(join(queueRoot, "render-queue.json"), "utf8"));
    assert.deepEqual(
      persisted.items.map((i) => i.status),
      report.jobs.map((i) => i.status),
    );
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await manager?.shutdown();
    await controller?.dispose();
    await logger?.flush();
    await writeAtomicJson(join(output, "report.json"), report);
    console.log(
      JSON.stringify({ status: report.status, jobs: report.jobs.length, error: report.error }),
    );
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
