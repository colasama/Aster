import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Exercise the production process adapter against real native outputs and control boundaries. */
export async function validateNativeQueueProcesses(context, preparedRuntime) {
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
  const { readNativeProjectImages } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-project-image-receipts.js"))
  );
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((c) => c.id === "scene-audio-spectrum-bars");
  const document = JSON.parse(await readFile(join(root, fixture.project)));
  for (const source of document.sources) {
    const entry = document.mediaImports.entries.find((e) => e.sourceId === source.id);
    const payload = document.mediaImports.payloads.find((p) => p.id === entry.payloadId);
    assert.equal(payload.storage.kind, "inline");
    source.dataUrl = `data:${source.mimeType};base64,${payload.storage.data}`;
  }
  const composition = document.compositions.find((c) => c.id === fixture.composition);
  const manifest = {
    id: "native-process-job",
    compositionId: fixture.composition,
    compositionName: "Process integration",
    projectRevision: 0,
    projectSnapshot: JSON.stringify(document),
    width: composition.width,
    height: composition.height,
    frameRate: composition.frameRate,
    startFrame: 3,
    endFrameExclusive: 15,
    priority: 0,
    createdAt: new Date().toISOString(),
    outputs: [
      {
        id: "still",
        kind: "still",
        format: "png",
        frame: 3,
        destination: join(output, "still.png"),
      },
      {
        id: "sequence",
        kind: "pngSequence",
        fileNamePattern: "frame_[######].png",
        destination: join(output, "sequence"),
      },
      {
        id: "video",
        kind: "mp4",
        codec: "h264",
        bitrateMbps: 20,
        includeAudio: true,
        destination: join(output, "video.mp4"),
      },
      {
        id: "muted",
        kind: "mp4",
        codec: "h264",
        bitrateMbps: 20,
        includeAudio: false,
        destination: join(output, "muted.mp4"),
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
  const images = async (receipt, item, destination) => {
    if (item.kind === "mp4") return undefined;
    const expected = {
      format: item.kind === "still" ? "png" : "png-sequence",
      projectSha256: receipt.project.authored_sha256,
      output: destination,
      width: manifest.width,
      height: manifest.height,
      frameRate: manifest.frameRate,
      startFrame: item.kind === "still" ? item.frame : manifest.startFrame,
      frames: item.kind === "still" ? 1 : manifest.endFrameExclusive - manifest.startFrame,
      bitrate: 20000000,
      includeAudio: false,
    };
    assert(expected.frames <= 1000, "Validation receipt capture must stay bounded");
    const captured = [];
    for await (const row of readNativeProjectImages(receipt, expected)) captured.push(row);
    return captured;
  };
  const report = {
    manifest,
    status: "failed",
    scope:
      "Native queue process adapter; complete queue scheduling and publication remain separate",
    cases: [],
    source: preparedRuntime.source,
  };
  const children = [];
  try {
    const project = await prepareNativeQueueProject({
      directory: join(output, "project"),
      manifest,
      authorizedPaths: [],
      runtime,
      resolvePlugins: async (references) => ({
        packages: await Promise.all(
          references.map(async (reference) => {
            const directory = join(root, fixture.plugins[0]);
            const shaders = (await readdir(directory)).filter((f) => f.endsWith(".wgsl"));
            return {
              ...reference,
              manifestToml: await readFile(join(directory, "plugin.toml"), "utf8"),
              shaderSources: Object.fromEntries(
                await Promise.all(
                  shaders.map(async (f) => [f, await readFile(join(directory, f), "utf8")]),
                ),
              ),
            };
          }),
        ),
        unavailable: [],
      }),
    });
    const start = async (outputId, destination, onEvent) => {
      const child = await startNativeQueueExport({
        manifest,
        prepared: project,
        outputId,
        destination,
        runtime,
        onEvent,
      });
      children.push(child);
      return child;
    };
    for (const item of manifest.outputs) {
      const events = [];
      const child = await start(item.id, item.destination, (event) => events.push(event));
      const receipt = await child.completion;
      const captured = await images(receipt, item, item.destination);
      if (captured)
        for (const image of captured) {
          const path = image.member ? join(item.destination, image.member) : item.destination;
          assert.equal(await hashFile(path), image.png_sha256);
          assert.equal((await stat(path)).size, image.bytes);
        }
      else {
        assert.equal((await stat(item.destination)).size, receipt.report.output_bytes);
        assert.equal(receipt.report.audio_frames > 0, item.includeAudio);
        const probe = await runStep(
          {
            id: `probe-${item.id}`,
            file: runtime.ffprobe,
            args: ["-v", "error", "-show_streams", "-of", "json", item.destination],
          },
          context,
        );
        assert.equal(probe.status, "passed");
        const log = await readFile(join(root, probe.log), "utf8");
        const streams = JSON.parse(log.slice(log.indexOf("\n") + 1)).streams;
        assert.equal(
          streams.some((s) => s.codec_type === "audio"),
          item.includeAudio,
        );
      }
      report.cases.push({ id: item.id, status: "passed", receipt, images: captured, events });
    }
    assert.equal(report.cases[0].images[0].rgba_sha256, report.cases[1].images[0].rgba_sha256);
    const controls = [],
      pending = [];
    let child,
      paused = false,
      requestedSecond = false;
    child = await start("sequence", join(output, "paused-sequence"), (event) => {
      controls.push(event);
      if (event.stage === "paused") {
        paused = true;
        const count = controls.length;
        pending.push(
          delay(60).then(() => {
            assert.equal(controls.length, count, "Paused native process advanced");
            paused = false;
            child.control("resume");
          }),
        );
      } else {
        assert.equal(paused, false, "Progress arrived after pause acknowledgement");
        if (event.rendered_frames >= 3 && !requestedSecond) {
          requestedSecond = true;
          child.control("pause");
        }
      }
    });
    child.control("pause");
    const resumed = await child.completion;
    await Promise.all(pending);
    assert.equal(controls.filter((e) => e.stage === "paused").length, 2);
    assert.deepEqual(
      await images(resumed, manifest.outputs[1], join(output, "paused-sequence")),
      report.cases[1].images,
    );
    report.cases.push({ id: "pause-resume", status: "passed", controls, exact: true });
    const cancelOutput = join(output, "cancelled");
    const cancelEvents = [];
    child = await start("sequence", cancelOutput, (event) => {
      cancelEvents.push(event);
      if (event.stage === "paused") child.control("cancel");
    });
    child.control("pause");
    await assert.rejects(child.completion, NativeProjectExportCancelled);
    await child.dispose();
    await assert.rejects(stat(cancelOutput));
    await assert.rejects(stat(`${cancelOutput}.receipts.jsonl`));
    assert.equal(cancelEvents.filter((e) => e.stage === "paused").length, 1);
    report.cases.push({ id: "cancel-after-pause", status: "passed", events: cancelEvents });
    const originalRequest = await readFile(project.request);
    await writeFile(project.request, Buffer.concat([originalRequest, Buffer.from(" ")]));
    await assert.rejects(start("still", join(output, "tampered.png")), /input changed/);
    await writeFile(project.request, originalRequest);
    report.cases.push({ id: "changed-request-rejected", status: "passed" });
    for (const change of [
      { width: manifest.width * 2 },
      {
        outputs: manifest.outputs.map((item) =>
          item.kind === "mp4" ? { ...item, bitrateMbps: 10 } : item,
        ),
      },
    ]) {
      await assert.rejects(
        startNativeQueueExport({
          manifest: { ...manifest, ...change },
          prepared: project,
          outputId: "video",
          destination: join(output, "changed.mp4"),
          runtime,
        }),
        /preparation receipts/,
      );
    }
    await assert.rejects(stat(join(output, "changed.mp4")));
    report.cases.push({ id: "changed-job-configuration-rejected", status: "passed" });
    await preparedRuntime.assertUnchanged();
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  } finally {
    await Promise.all(children.map((child) => child.dispose()));
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
