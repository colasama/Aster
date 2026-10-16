import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { nativeExportSchedule, summarizeNativeExportSeries } from "./native-export-series.mjs";
import { RendererCpuCapture } from "./renderer-cpu-capture.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_OWNER_EXPORT_CONFIG, "utf8"));
const { root, output, privateRoot } = config;
const cpuCapture = config.profile ? new RendererCpuCapture(join(output, "profiles")) : undefined;
let profileNextWindow = false;
assert(config.appPath && config.nativeRuntime?.runtimeDirectory, "Fresh owner runtime is required");
const load = (name) =>
  import(pathToFileURL(join(config.nativeRuntime.runtimeDirectory, `electron/${name}.js`)));
const assets = await load("asset-protocol");
protocol.registerSchemesAsPrivileged([assets.ASSET_SCHEME_REGISTRATION]);
app.setPath("userData", join(privateRoot, "profile"));
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
  if (profileNextWindow) {
    profileNextWindow = false;
    cpuCapture?.watch(window);
  }
});

async function main() {
  const report = {
    status: "failed",
    native_export_acceptance: false,
    jobs: [],
    routes: [],
    errors: [],
    measurement:
      "enqueue to durable completion, including window load, native admission/spooling, encode, audio and publication; media snapshot capture separately reported",
  };
  let manager, controller, logger;
  try {
    const { ElectronRenderHostController } = await load("render-queue-host");
    const { RenderQueueStore } = await load("render-queue-store");
    const { RenderQueueManager } = await load("render-queue-manager");
    const { RenderMediaSnapshotStore } = await load("render-media-snapshot-store");
    const { renderPathKey } = await load("render-queue-paths");
    const { fetchLocalAsset } = await load("local-file-response");
    const { AsterLogger } = await load("logger");
    const { nativeRenderRuntime } = await load("native-render-runtime");
    const { defaultAppPreferences } = await import(
      pathToFileURL(join(config.nativeRuntime.runtimeDirectory, "src/desktop/preferences.js"))
    );
    await app.whenReady();
    report.gpu_info = await app.getGPUInfo("complete");
    // Queue SVG identities are defined by Chromium serialization, just like interactive imports.
    const parserWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await parserWindow.loadURL("about:blank");
      const code = readFileSync(join(privateRoot, "parser/svg.js"), "utf8");
      const parsed = await parserWindow.webContents.executeJavaScript(
        `${code}\n(${JSON.stringify(config.svgInputs)}).map(input => ({ sourceId: input.sourceId, parsed: OwnerSvg.parseSvgSource(input.text) }))`,
      );
      const media = JSON.parse(config.manifest.renderMediaSnapshot);
      for (const entry of media.entries.filter((e) => e.kind === "svg")) {
        const source = parsed.find((p) => p.sourceId === entry.sourceId);
        assert(source, "SVG source was not captured");
        entry.parsed = source.parsed;
      }
      config.manifest.renderMediaSnapshot = JSON.stringify(media);
    } finally {
      parserWindow.destroy();
    }
    const allowedAssets = new Map(config.allowed.map((p) => [renderPathKey(p), p]));
    protocol.handle(
      assets.ASSET_SCHEME,
      assets.createAssetProtocolHandler({ allowedAssets, fetchFile: fetchLocalAsset }),
    );
    ipcMain.handle("aster:preferences-get", () => defaultAppPreferences());
    ipcMain.handle("aster:gpu-memory-devices", () => []);
    ipcMain.on("aster:log", (_e, entry) => {
      if (entry.level === "error") report.errors.push(entry);
    });
    logger = new AsterLogger({ directory: join(output, "logs"), level: "debug" });
    await logger.initialize();
    const info = logger.info.bind(logger);
    logger.info = (scope, event, data) => {
      if (event === "native_export_route") {
        report.routes.push({ ...data, elapsed_ms: performance.now() - started });
        if (data.jobId === "owner-rust") void cpuCapture?.finish().catch(() => undefined);
      }
      info(scope, event, data);
    };
    const snapshots = new RenderMediaSnapshotStore(join(privateRoot, "media"));
    const snapshotId = "owner-frozen";
    const capturedAt = performance.now();
    const frozen = await snapshots.capture(snapshotId, config.manifest.renderMediaSnapshot, {
      allowedAssets,
    });
    snapshots.commit(snapshotId);
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ ...config.manifest, renderMediaSnapshot: frozen }))
      .digest("hex");
    report.snapshot_ms = performance.now() - capturedAt;
    report.linked_media_count = JSON.parse(frozen).entries.length;
    const queueRoot = join(privateRoot, "queue");
    await mkdir(queueRoot);
    const store = new RenderQueueStore(queueRoot);
    await store.initialize();
    const ffmpeg = join(root, "build/ffmpeg/ffmpeg.exe");
    const defaults = nativeRenderRuntime({
      appPath: root,
      resourcesPath: join(root, "resources"),
      packaged: false,
      executable: process.execPath,
      temporaryDirectory: privateRoot,
      ffmpeg,
    });
    assert(defaults, "Native owner runtime is unavailable");
    const runtime = { ...defaults, ...config.nativeRuntime };
    if (config.paired)
      assert.equal(
        process.env.NODE_ENV,
        "production",
        "Paired exports require a production runtime",
      );
    report.runtime = { node_env: process.env.NODE_ENV ?? null };
    for (const key of ["binary", "compiler", "ffprobe"])
      report.runtime[key] = { sha256: await hashFile(runtime[key]) };
    report.runtime.ffmpeg = { sha256: await hashFile(ffmpeg) };
    report.runtime.electron = {
      version: process.versions.electron,
      sha256: await hashFile(process.execPath),
    };
    const options = {
      appPath: config.appPath,
      developmentUrl: "http://127.0.0.1:1420",
      packaged: true,
      ffmpegExecutable: ffmpeg,
      logger,
      nativeRuntime: runtime,
      authorizeMedia: () => snapshots.authorizeLaunch(snapshotId, frozen, { allowedAssets }),
    };
    let selected, terminal, started;
    const samples = [];
    let previousFrame = 0;
    const commandErrors = [];
    manager = new RenderQueueManager(
      store,
      (state) => {
        const item = state.items.find((i) => i.manifest.id === selected);
        if (!item) return;
        report.last_progress = {
          job_id: selected,
          status: item.status,
          progress: item.progress,
          elapsed_ms: performance.now() - started,
        };
        if (item.progress.completedFrames > previousFrame) {
          samples.push({
            frames: item.progress.completedFrames,
            elapsed_ms: performance.now() - started,
          });
          previousFrame = item.progress.completedFrames;
        }
        if (["completed", "failed", "cancelled"].includes(item.status)) terminal?.(item);
      },
      undefined,
      (error) => commandErrors.push(String(error)),
    );
    controller = new ElectronRenderHostController(options);
    controller.registerIpc();
    await manager.startScheduler(controller, 1);
    report.schedule = nativeExportSchedule(config.manifest, config);
    for (const observation of report.schedule) {
      const { renderer } = observation;
      selected = observation.id;
      options.nativeRuntime = renderer === "rust" ? runtime : undefined;
      const manifest = {
        ...structuredClone(config.manifest),
        renderMediaSnapshot: frozen,
        id: selected,
        priority: 1,
        createdAt: new Date().toISOString(),
        startFrame: observation.start_frame,
        endFrameExclusive: observation.end_frame_exclusive,
      };
      manifest.outputs[0].destination = join(output, `${config.paired ? selected : renderer}.mp4`);
      samples.length = 0;
      previousFrame = 0;
      let timeout;
      const completed = new Promise((done, reject) => {
        terminal = done;
        timeout = setTimeout(
          () => reject(new Error(`Owner ${selected} export timed out`)),
          Math.max(600000, (manifest.endFrameExclusive - manifest.startFrame) * 2000),
        );
      });
      started = performance.now();
      profileNextWindow = config.profile && renderer === "rust";
      let item;
      try {
        await manager.enqueue(manifest);
        item = await completed;
      } finally {
        clearTimeout(timeout);
        terminal = undefined;
      }
      const elapsed = performance.now() - started;
      const route = report.routes.find((r) => r.jobId === selected);
      const evidence = {
        ...observation,
        input_sha256: inputHash,
        renderer,
        status: item.status,
        error: item.error,
        route,
        elapsed_ms: elapsed,
        progress: item.progress,
        frame_progress: [...samples],
      };
      report.jobs.push(evidence);
      assert.equal(item.status, "completed", JSON.stringify(item.error));
      assert.equal(route?.renderer, renderer, JSON.stringify(route));
      const frames = manifest.endFrameExclusive - manifest.startFrame;
      assert.equal(item.progress.completedFrames, frames);
      evidence.fps = (frames * 1000) / elapsed;
      const probe = await new Promise((done, reject) =>
        execFile(
          runtime.ffprobe,
          [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            manifest.outputs[0].destination,
          ],
          { windowsHide: true, timeout: 120000 },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error}: ${stderr}`)) : done(JSON.parse(stdout)),
        ),
      );
      const video = probe.streams.find((s) => s.codec_type === "video");
      const audio = probe.streams.find((s) => s.codec_type === "audio");
      assert.equal(video.codec_name, "h264");
      assert.equal(video.width, manifest.width);
      assert.equal(video.height, manifest.height);
      assert.equal(Number(video.nb_read_frames), frames);
      const duration = (frames * manifest.frameRate.denominator) / manifest.frameRate.numerator;
      assert(Math.abs(Number(video.duration) - duration) <= 1 / 30);
      if (manifest.outputs[0].includeAudio) {
        assert(audio, "Owner export must contain audio");
        assert.equal(Number(audio.sample_rate), 48000);
        assert.equal(audio.channels, 2);
        assert(Math.abs(Number(audio.duration) - Number(video.duration)) <= 0.05);
      } else assert.equal(audio, undefined);
      evidence.probe = probe;
      evidence.sha256 = await hashFile(manifest.outputs[0].destination);
      evidence.output_path = manifest.outputs[0].destination;
      for (let i = 0; i < 100 && manager.activeHostCount; i++) await delay(50);
      assert.equal(manager.activeHostCount, 0);
      assert.deepEqual(commandErrors, []);
      assert.deepEqual(await readdir(runtime.temporaryRoot), []);
      console.log(`owner: ${selected} ${frames} frames completed in ${elapsed.toFixed(0)} ms`);
    }
    if (config.paired) report.series = summarizeNativeExportSeries(report.jobs, config.manifest);
    if (cpuCapture) {
      report.cpu_profiles = await cpuCapture.finish();
      assert.equal(report.cpu_profiles.length, 1);
      report.measurement = "Renderer CPU sampling diagnostic; not paired performance acceptance";
    }
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await manager?.shutdown();
    await controller?.dispose();
    await logger?.flush();
    await writeAtomicJson(join(output, "queue-report.json"), report);
    console.log(JSON.stringify({ status: report.status, error: report.error }));
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
