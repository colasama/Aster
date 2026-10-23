import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "./report.mjs";

/** Qualify large schedule admission and cooperative shutdown, not complete long-job delivery. */
export async function validateNativeQueueLongControl(context, preparedRuntime) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const { prepareNativeQueueProject } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-queue-project.js"))
  );
  const { startNativeQueueExport } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-queue-export.js"))
  );
  const { NativeProjectExportCancelled } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-project-export-process.js"))
  );
  const document = JSON.parse(
    await readFile(join(root, "examples/projects/minimal-golden.aster.json")),
  );
  const composition = document.compositions[0];
  composition.duration = 400000;
  composition.workArea = { start: 0, end: composition.duration };
  composition.frameRate = { numerator: 30000, denominator: 1001 };
  const destination = join(output, "cancelled.mp4");
  const manifest = {
    id: "long-control",
    compositionId: composition.id,
    compositionName: composition.name,
    projectRevision: 0,
    projectSnapshot: JSON.stringify(document),
    width: composition.width,
    height: composition.height,
    frameRate: composition.frameRate,
    startFrame: 17,
    endFrameExclusive: 10000017,
    priority: 0,
    createdAt: new Date().toISOString(),
    outputs: [
      {
        id: "video",
        kind: "mp4",
        codec: "h264",
        bitrateMbps: 20,
        includeAudio: false,
        destination,
      },
    ],
  };
  const runtime = {
    renderer: preparedRuntime.binary,
    executable: preparedRuntime.rasterProvider.executable,
    host: preparedRuntime.rasterProvider.arguments[0],
    bundle: preparedRuntime.rasterProvider.bundle,
    bridge: preparedRuntime.rasterProvider.bridge,
    ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
    ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
    compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
  };
  const report = {
    status: "failed",
    scope: "10,000,000-frame admission and pause/cancel only",
    events: [],
    frames: 10000000,
  };
  let child;
  let timer;
  try {
    const project = await prepareNativeQueueProject({
      directory: join(output, "project"),
      manifest,
      authorizedPaths: [],
      runtime,
    });
    let acknowledge;
    const paused = new Promise((resolve) => {
      acknowledge = resolve;
    });
    child = await startNativeQueueExport({
      manifest,
      prepared: project,
      outputId: "video",
      destination,
      runtime,
      onEvent: (event) => {
        report.events.push(event);
        if (event.stage === "paused") acknowledge();
      },
    });
    const completion = child.completion.then(
      () => {
        throw new Error("Long control unexpectedly completed");
      },
      (error) => error,
    );
    // Let preflight begin before asking for a safe processing boundary.
    await delay(1500);
    const requested = performance.now();
    child.control("pause");
    await Promise.race([
      paused,
      completion.then((error) => {
        throw error;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Long schedule pause timed out")), 15000);
      }),
    ]);
    clearTimeout(timer);
    report.pause_latency_ms = performance.now() - requested;
    const count = report.events.length;
    await delay(100);
    assert.equal(report.events.length, count);
    const cancelled = performance.now();
    child.control("cancel");
    assert((await completion) instanceof NativeProjectExportCancelled);
    await child.dispose();
    report.cancel_latency_ms = performance.now() - cancelled;
    await assert.rejects(stat(destination));
    assert.equal(report.events.filter((event) => event.stage === "paused").length, 1);
    assert.equal(report.events.filter((event) => event.rendered_frames > 0).length, 0);
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  } finally {
    clearTimeout(timer);
    await child?.dispose();
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
