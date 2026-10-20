import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import electron from "electron";
import { preview } from "vite";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { auditCorpusAudiovisual } from "./native-corpus-runs.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export async function runCorpusExports(context, assignments) {
  const { root, output } = context,
    local = (p) => relative(root, p).replaceAll("\\", "/");
  const json = async (p) => JSON.parse(await readFile(p, "utf8"));
  const prepared = context.preparedProject;
  assert(prepared, "Prepared native project runtime required");
  await prepared.assertUnchanged();
  const binary = prepared.binary;
  const binaries = {
    ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
    ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
  };
  const compiler = join(root, "node_modules/electron/dist/dxcompiler.dll");
  const pins = await Promise.all(
    [binary, ...Object.values(binaries), compiler, electron].map(async (path) => ({
      path: local(path),
      sha256: await hashFile(path),
    })),
  );
  const retained = await loadRetainedPerformanceRuntime(root),
    arms = {};
  const provider = prepared.rasterProvider;
  assert(provider, "Native project export requires a prepared raster-only provider");
  await writeAtomicJson(join(output, "run-inputs.json"), {
    source: context.source,
    binaries: pins,
    assignments,
    retained: retained.provenance,
    execution: prepared.execution.snapshot,
  });
  const directory = join(output, "rust");
  await mkdir(directory);
  const cases = [],
    audiovisual = [];
  for (const job of assignments) {
    const request = join(directory, `${job.case.id}.request.json`);
    const scale = job.case.aa === "ssaa4x" ? 4 : job.case.aa === "ssaa2x" ? 2 : 1;
    const settings = {
      resources: {
        visualization: "beauty",
        locale: "en-US",
        layouts: {},
        surface: {
          revision: 1,
          maxTextureDimension: 4096,
          memoryBudgetMb: 512,
          renderScale: scale,
        },
        maximumRasterDimension: 8192,
        maximumRasterPixels: 67108864,
      },
      selectedLayerId: null,
      shadowMapSize: 1024,
    };
    await writeAtomicJson(request, {
      settings,
      plugins: (job.case.plugins ?? []).map((p) => join(root, p, "plugin.toml")),
      rasterProvider: provider,
    });
    const path = join(directory, `${job.case.id}.mp4`),
      witness = join(directory, `${job.case.id}-witness`);
    const start = job.benchmark.startFrame,
      count = job.benchmark.endFrameExclusive - start;
    const indices = job.case.frames.toSorted((a, b) => a - b).map((f) => f - start);
    const args = [
      "export",
      "--project",
      job.projectPath,
      "--composition",
      job.case.composition,
      "--out",
      path,
      "--request",
      request,
      "--start-frame",
      String(start),
      "--frames",
      String(count),
      "--width",
      String(job.case.size.width),
      "--height",
      String(job.case.size.height),
      "--aa",
      job.case.aa,
      "--bitrate",
      "20000000",
      "--fps-numerator",
      String(job.benchmark.frameRate.numerator),
      "--fps-denominator",
      String(job.benchmark.frameRate.denominator),
      "--ffmpeg",
      binaries.ffmpeg,
      "--ffprobe",
      binaries.ffprobe,
      "--dxcompiler",
      compiler,
      "--layer-cache-bytes",
      "0",
      "--effect-pipeline-entries",
      "0",
      "--render-project-frames",
      "65536",
      "--witness",
      witness,
      "--witness-frames",
      indices.join(","),
      "--witness-bytes",
      "8589934592",
    ];
    const step = await runStep(
      { id: job.case.id, file: binary, args, timeout_ms: 900000 },
      { ...context, output: directory },
    );
    assert.equal(step.status, "passed");
    const lines = (await readFile(resolve(root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.startsWith("{"));
    const receipt = JSON.parse(lines.at(-1));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.report.frames, count);
    assert.equal(receipt.report.encoder.encoded_frames, count);
    assert(receipt.report.encoder.drain_completed);
    const proof = await json(receipt.witness.path);
    assert.equal(await hashFile(receipt.witness.path), receipt.witness.report_sha256);
    assert.equal(proof.output_sha256, await hashFile(path));
    assert.deepEqual(
      proof.frames.map((f) => f.index),
      indices,
    );
    assert.equal(proof.project_authored_sha256, receipt.project.authored_sha256);
    assert.deepEqual(proof.video, receipt.video);
    assert.deepEqual(proof.adapter, receipt.adapter);
    for (const frame of proof.frames) {
      assert.equal(
        frame.time,
        ((start + frame.index) * job.benchmark.frameRate.denominator) /
          job.benchmark.frameRate.numerator,
      );
      const base = join(witness, String(frame.index));
      assert.equal(await hashFile(join(base, "candidate.png")), frame.rgb.png_sha256);
      assert.equal(await hashFile(join(base, "plan.fpln")), frame.rgb.plan_sha256);
      assert.equal(await hashFile(join(base, "input.nv12")), frame.nv12_sha256);
      assert.equal(frame.nv12_bytes, (job.case.size.width * job.case.size.height * 3) / 2);
    }
    const probeStep = await runStep(
      {
        id: `${job.case.id}-probe`,
        file: binaries.ffprobe,
        args: [
          "-v",
          "error",
          "-count_frames",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          path,
        ],
      },
      { ...context, output: directory },
    );
    assert.equal(probeStep.status, "passed");
    const probeLog = await readFile(resolve(root, probeStep.log), "utf8"),
      probe = JSON.parse(probeLog.slice(probeLog.indexOf("\n") + 1));
    const entry = {
      caseId: job.case.id,
      case_hash: job.caseHash,
      inputs: job.inputs,
      status: "passed",
      benchmark: { ...job.benchmark, id: `${job.case.id}-rust-corpus-export`, renderer: "rust" },
      result: {
        renderer: "rust",
        startFrame: start,
        endFrameExclusive: start + count,
        frames: count,
        ...(receipt.report.audio_frames
          ? {
              audio: {
                enabled: true,
                sampleRate: 48000,
                channels: 2,
                frameCount: receipt.report.audio_frames,
              },
            }
          : {}),
      },
      output: {
        outputPath: path,
        videoBitrateBps: 20000000,
        audioFrames: receipt.report.audio_frames,
        ffprobe: { sha256: await hashFile(path), result: probe },
      },
      receipt,
      witness: proof,
      step,
    };
    audiovisual.push(auditCorpusAudiovisual(job, entry));
    cases.push(entry);
    await writeAtomicJson(join(directory, "report.json"), { status: "running", cases });
  }
  await writeAtomicJson(join(directory, "report.json"), { status: "passed", cases });
  arms.rust = {
    path: local(join(directory, "report.json")),
    sha256: await hashFile(join(directory, "report.json")),
    raw: { status: "passed", cases },
    audiovisual,
  };
  const ts = join(output, "ts");
  await mkdir(ts);
  let server;
  try {
    server = await preview({
      configFile: false,
      root,
      build: { outDir: retained.browser.directory },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const selected = assignments.map((j) => ({
      ...j,
      benchmark: { ...j.benchmark, id: `${j.case.id}-ts-corpus-export` },
    }));
    const config = join(ts, "config.json");
    await writeAtomicJson(config, {
      root,
      suite: "throughput",
      runId: `native-project-ts-${Date.now()}`,
      runDirectory: join(ts, "execution"),
      assignments: selected,
      binaries,
      source: retained.browser.rendererSource,
      retainedRuntime: true,
      timeoutMs: 900000,
      url: new URL("tests/performance/harness.html", server.resolvedUrls.local[0]).href,
    });
    const env = { ...context.env, NODE_ENV: "production" };
    delete env.ELECTRON_RUN_AS_NODE;
    const step = await runStep(
      {
        id: "retained-ts",
        file: electron,
        args: ["scripts/performance/electron-main.mjs"],
        env: { ASTER_PERFORMANCE_CONFIG: config },
        timeout_ms: 900000 * (selected.length + 1),
      },
      { ...context, output: ts, env },
    );
    const path = join(ts, "execution/report.json"),
      raw = await json(path);
    assert.equal(step.status, "passed", raw.error);
    assert.equal(raw.status, "passed", raw.error);
    assert.deepEqual(raw.retained_runtime, retained.provenance);
    assert.equal(raw.cases.length, selected.length);
    const audits = [];
    for (const [i, entry] of raw.cases.entries()) {
      const j = selected[i];
      assert.equal(entry.status, "passed");
      assert.equal(entry.caseId, j.case.id);
      assert.equal(entry.case_hash, j.caseHash);
      assert.deepEqual(entry.inputs, j.inputs);
      assert.deepEqual(entry.benchmark, j.benchmark);
      assert.equal(entry.result.startFrame, j.benchmark.startFrame);
      assert.equal(entry.result.endFrameExclusive, j.benchmark.endFrameExclusive);
      assert.equal(entry.result.frames, j.benchmark.endFrameExclusive - j.benchmark.startFrame);
      assert.equal(entry.output.videoBitrateBps, 20000000);
      assert.equal(await hashFile(entry.output.outputPath), entry.output.ffprobe.sha256);
      audits.push(auditCorpusAudiovisual(j, entry));
    }
    arms.ts = { path: local(path), sha256: await hashFile(path), raw, audiovisual: audits };
  } finally {
    await server?.close();
  }
  await prepared.assertUnchanged();
  await retained.assertStable();
  for (const pin of pins) assert.equal(await hashFile(join(root, pin.path)), pin.sha256);
  return {
    kind: "native-project-export",
    arms,
    execution: prepared.execution.snapshot,
    build: prepared.build,
    native_binary: local(binary),
    binaries: pins,
    retained: retained.provenance,
    scope:
      "Native project export versus independently retained TS; diagnostic until full gate integration and self-review",
  };
}
