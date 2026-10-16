import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import electron from "electron";
import { preview } from "vite";
import { validateProbe } from "../performance/output-session.mjs";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { prepareNativeObservationRuntime } from "./native-observation-runtime.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Bind stream timing to the complete addressed segment, including required production audio. */
export function auditCorpusAudiovisual(assignment, entry) {
  const { benchmark, case: item } = assignment;
  const frameCount = benchmark.endFrameExclusive - benchmark.startFrame;
  const duration = (frameCount * benchmark.frameRate.denominator) / benchmark.frameRate.numerator;
  const audio = entry.result.audio;
  if (benchmark.requireAudio) assert(audio, "Corpus workload requires audio");
  if (audio) {
    assert.equal(audio.enabled, true);
    assert.equal(audio.sampleRate, 48000);
    assert.equal(audio.channels, 2);
    assert.equal(audio.frameCount, Math.round(duration * audio.sampleRate));
    assert.equal(entry.output.audioFrames, audio.frameCount);
  }
  const probe = entry.output.ffprobe.result;
  validateProbe(probe, {
    ...item.size,
    frameCount,
    frameRateNumerator: benchmark.frameRate.numerator,
    frameRateDenominator: benchmark.frameRate.denominator,
    ...(audio ? { audio } : {}),
  });
  const streams = probe.streams.map((stream) => {
    assert.notEqual(stream.start_time, undefined, "Missing stream start timestamp");
    const start = Number(stream.start_time);
    assert(Number.isFinite(start) && Math.abs(start) <= 0.001, "Export stream is not zero-based");
    return {
      type: stream.codec_type,
      start_seconds: start,
      duration_seconds: Number(stream.duration),
    };
  });
  return {
    status: "passed",
    required_audio: Boolean(benchmark.requireAudio),
    audio_frames: audio?.frameCount ?? 0,
    segment_start_frame: benchmark.startFrame,
    frame_count: frameCount,
    duration_seconds: duration,
    streams,
    scope:
      "Stream presence, PCM frame count, zero-based starts and matching durations; not decoded audio content alignment",
  };
}

/** Reuse both real production render hosts; these quality runs never grant performance acceptance. */
export async function runCorpusExports(context, assignments) {
  const { root, output } = context;
  const env = { ...context.env, NODE_ENV: "production" };
  delete env.ELECTRON_RUN_AS_NODE;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const prepared = context.preparedNative ?? (await prepareNativeObservationRuntime(context));
  assert.equal(prepared.source.source_sha256, context.source.source_sha256);
  await prepared.assertUnchanged();
  const { build, execution, nativeRuntime, webDirectory } = prepared;
  const retained = await loadRetainedPerformanceRuntime(root);
  const binary = nativeRuntime.binary;
  const binaries = {
    ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
    ffprobe: nativeRuntime.ffprobe,
  };
  const hashes = [];
  for (const path of [...Object.values(binaries), binary, nativeRuntime.compiler, electron])
    hashes.push({ path: local(path), sha256: await hashFile(path) });
  const arms = {};
  for (const renderer of ["rust", "ts"]) {
    const directory = join(output, renderer);
    await mkdir(directory);
    let server;
    try {
      server = await preview({
        configFile: false,
        root,
        build: { outDir: renderer === "ts" ? retained.browser.directory : webDirectory },
        preview: { host: "127.0.0.1", port: 0 },
      });
      const selected = assignments.map((item) => ({
        ...item,
        benchmark: {
          ...item.benchmark,
          id: `${item.case.id}-${renderer}-corpus-export`,
          ...(renderer === "rust" ? { renderer: "rust" } : {}),
        },
      }));
      const config = join(directory, "config.json");
      await writeAtomicJson(config, {
        root,
        suite: "throughput",
        runId: `corpus-${renderer}-${Date.now()}`,
        runDirectory: join(directory, "execution"),
        assignments: selected,
        binaries,
        source: renderer === "ts" ? retained.browser.rendererSource : context.source,
        retainedRuntime: renderer === "ts",
        ...(renderer === "rust" ? { nativeRuntime } : {}),
        timeoutMs: 900000,
        url: new URL("tests/performance/harness.html", server.resolvedUrls.local[0]).href,
      });
      const step = await runStep(
        {
          id: `corpus-${renderer}`,
          file: electron,
          args: ["scripts/performance/electron-main.mjs"],
          env: { ASTER_PERFORMANCE_CONFIG: config },
          timeout_ms: 900000 * (assignments.length + 1),
        },
        { ...context, output: directory, env },
      );
      const path = join(directory, "execution/report.json");
      const raw = JSON.parse(await readFile(path, "utf8"));
      assert.equal(step.status, "passed", raw.error);
      assert.equal(raw.status, "passed", raw.error);
      assert.equal(raw.cases.length, selected.length);
      if (renderer === "ts") assert.deepEqual(raw.retained_runtime, retained.provenance);
      const audiovisual = [];
      for (const [index, entry] of raw.cases.entries()) {
        assert.equal(entry.status, "passed");
        assert.equal(entry.caseId, selected[index].case.id);
        assert.equal(entry.case_hash, selected[index].caseHash);
        assert.deepEqual(entry.inputs, selected[index].inputs);
        assert.deepEqual(entry.benchmark, selected[index].benchmark);
        assert.equal(entry.result.startFrame, selected[index].benchmark.startFrame);
        assert.equal(entry.result.endFrameExclusive, selected[index].benchmark.endFrameExclusive);
        assert.equal(entry.output.videoBitrateBps, 20000000);
        assert.equal(
          entry.result.frames,
          entry.benchmark.endFrameExclusive - entry.benchmark.startFrame,
        );
        if (renderer === "rust") assert.equal(entry.result.renderer, "rust");
        assert.equal(await hashFile(entry.output.outputPath), entry.output.ffprobe.sha256);
        audiovisual.push(auditCorpusAudiovisual(selected[index], entry));
      }
      arms[renderer] = { path: local(path), sha256: await hashFile(path), raw, audiovisual };
    } finally {
      await server?.close();
    }
  }
  await prepared.assertUnchanged();
  await retained.assertStable();
  for (const entry of hashes) assert.equal(await hashFile(join(root, entry.path)), entry.sha256);
  return {
    arms,
    native_binary: local(binary),
    build,
    binaries: hashes,
    execution: execution.snapshot,
    retained: retained.provenance,
  };
}
