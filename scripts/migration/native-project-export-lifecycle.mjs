import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureAssignments } from "../parity/provenance.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";
export async function runProjectExportLifecycle(context, prepared) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  await prepared.assertUnchanged();
  const cli = prepared.binary,
    ffprobe = join(root, "build/ffmpeg/ffprobe.exe");
  const json = async (p) => JSON.parse(await readFile(p, "utf8"));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aster-project-lifecycle-"));
  const temporary = async () => (await readdir(temporaryRoot)).sort();
  const report = {
    status: "failed",
    scope: "Native headless project timing and lifecycle; pixel and quality gates remain separate",
    source: await sourceProvenance(root),
    binary: { path: relative(root, cli), sha256: await hashFile(cli) },
    cases: [],
    controls: [],
    temporary_root: temporaryRoot,
  };

  async function run(name, file, args, onProgress) {
    const child = spawn(file, args, {
      env: { ...context.env, TEMP: temporaryRoot, TMP: temporaryRoot },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      buffer = "";
    const rows = [];
    const completion = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr, rows }));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          rows.push(value);
          onProgress?.(value, child, rows);
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.stdin.write('{"action":"cancel"}\n');
      setTimeout(() => child.kill(), 5000).unref();
    }, 180000);
    timer.unref();
    const result = await completion;
    clearTimeout(timer);
    await writeFile(join(output, `${name}.stdout.log`), stdout);
    await writeFile(join(output, `${name}.stderr.log`), stderr);
    return result;
  }
  try {
    const before = await temporary(),
      corpus = await json(join(root, "tests/parity/corpus.json")),
      provider = prepared.rasterProvider;
    const jobs = await captureAssignments(
      root,
      ["minimal-golden", "layer-text", "owner-opening", "scene-audio-spectrum-bars"].map((id) =>
        corpus.cases.find((c) => c.id === id),
      ),
      context.env,
    );
    assert(jobs.every((job) => !job.unavailable));
    const common = [
      "--ffmpeg",
      resolve("build/ffmpeg/ffmpeg.exe"),
      "--ffprobe",
      ffprobe,
      "--dxcompiler",
      resolve("node_modules/electron/dist/dxcompiler.dll"),
      "--layer-cache-bytes",
      "0",
      "--effect-pipeline-entries",
      "0",
      "--control-stdin",
    ];
    async function argumentsFor(id, name, frames = 12) {
      const job = jobs.find((j) => j.case.id === id);
      assert(job, id);
      const start = job.case.frames[0];
      const scale = job.case.aa === "ssaa4x" ? 4 : job.case.aa === "ssaa2x" ? 2 : 1;
      const config = {
        settings: {
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
        },
        plugins: (job.case.plugins ?? []).map((p) => join(root, p, "plugin.toml")),
        rasterProvider: provider,
      };
      const request = join(output, `${name}.request.json`);
      await writeAtomicJson(request, config);
      return [
        "export",
        "--project",
        job.projectPath,
        "--composition",
        job.case.composition,
        "--out",
        join(output, `${name}.mp4`),
        "--request",
        request,
        "--frames",
        String(frames),
        "--start-frame",
        String(start),
        "--witness",
        join(output, `${name}-witness`),
        "--witness-frames",
        "0,1,5,11",
        "--width",
        "320",
        "--height",
        "180",
        "--bitrate",
        "6000000",
        ...common,
      ];
    }
    for (const id of ["minimal-golden"]) {
      const args = await argumentsFor(id, id);
      if (id === "minimal-golden")
        args.push("--fps-numerator", "30000", "--fps-denominator", "1001");
      const result = await run(id, cli, args);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const receipt = result.rows.at(-1);
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.report.frames, 12);
      assert(receipt.report.encoder.drain_completed);
      assert.equal(receipt.report.encoder.encoded_frames, 12);
      const probed = await run(`${id}-probe`, ffprobe, [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        join(output, `${id}.mp4`),
      ]);
      assert.equal(probed.code, 0);
      const probe = JSON.parse(probed.stdout),
        video = probe.streams.find((s) => s.codec_type === "video");
      assert.equal(Number(video.nb_read_frames), 12);
      assert.equal(video.codec_name, "h264");
      assert.equal(video.color_space, "bt709");
      assert.equal(video.color_range, "tv");
      assert.equal(
        video.avg_frame_rate,
        `${receipt.video.frame_rate.numerator}/${receipt.video.frame_rate.denominator}`,
      );
      const duration =
        (12 * receipt.video.frame_rate.denominator) / receipt.video.frame_rate.numerator;
      assert(Math.abs(Number(video.duration) - duration) < 1 / 90000);
      const audio = probe.streams.find((s) => s.codec_type === "audio");
      if (receipt.report.audio_frames > 0) {
        assert(audio);
        assert.equal(audio.codec_name, "aac");
        assert.equal(Number(audio.sample_rate), 48000);
        assert.equal(audio.channels, 2);
        assert(Math.abs(Number(audio.duration) - duration) < 0.025);
      }
      const witness = await json(receipt.witness.path);
      assert.equal(await hashFile(receipt.witness.path), receipt.witness.report_sha256);
      assert.equal(witness.output_sha256, await hashFile(join(output, `${id}.mp4`)));
      assert.equal(witness.project_authored_sha256, receipt.project.authored_sha256);
      assert.deepEqual(witness.video, receipt.video);
      assert.deepEqual(witness.adapter, receipt.adapter);
      assert.deepEqual(
        witness.frames.map((f) => f.index),
        [0, 1, 5, 11],
      );
      const corpus = await json("tests/parity/corpus.json"),
        start = corpus.cases.find((c) => c.id === id).frames[0];
      for (const f of witness.frames) {
        const rate = receipt.video.frame_rate;
        assert.equal(f.time, ((start + f.index) * rate.denominator) / rate.numerator);
        const base = join(output, `${id}-witness`, String(f.index));
        assert.equal(await hashFile(join(base, "candidate.png")), f.rgb.png_sha256);
        assert.equal(await hashFile(join(base, "plan.fpln")), f.rgb.plan_sha256);
        assert.equal(await hashFile(join(base, "input.nv12")), f.nv12_sha256);
        assert.equal(f.nv12_bytes, (320 * 180 * 3) / 2);
        assert.equal(f.nv12_binding, "exact-encoder-memory-input");
      }
      report.cases.push({
        id,
        receipt,
        probe,
        witness,
        sha256: await hashFile(join(output, `${id}.mp4`)),
      });
      context.print?.(`${id} lifecycle export passed ${receipt.report.transport}`);
    }
    const audioExports = [];
    for (const includeAudio of [true, false]) {
      const name = includeAudio ? "audio-included" : "audio-omitted";
      const args = await argumentsFor("scene-audio-spectrum-bars", name);
      if (!includeAudio) args.push("--no-audio");
      const result = await run(name, cli, args);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const receipt = result.rows.at(-1);
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.report.frames, 12);
      assert.equal(receipt.report.audio_frames > 0, includeAudio);
      assert(receipt.report.encoder.drain_completed);
      assert.equal(receipt.report.encoder.encoded_frames, 12);
      const probed = await run(`${name}-probe`, ffprobe, [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-of",
        "json",
        join(output, `${name}.mp4`),
      ]);
      assert.equal(probed.code, 0, probed.stderr);
      const probe = JSON.parse(probed.stdout);
      assert.equal(
        probe.streams.filter((s) => s.codec_type === "audio").length,
        includeAudio ? 1 : 0,
      );
      const video = probe.streams.find((s) => s.codec_type === "video");
      assert.equal(Number(video.nb_read_frames), 12);
      assert.equal(
        video.avg_frame_rate,
        `${receipt.video.frame_rate.numerator}/${receipt.video.frame_rate.denominator}`,
      );
      const witness = await json(receipt.witness.path);
      assert.equal(await hashFile(receipt.witness.path), receipt.witness.report_sha256);
      assert.equal(witness.output_sha256, await hashFile(join(output, `${name}.mp4`)));
      assert.deepEqual(
        witness.frames.map((f) => f.index),
        [0, 1, 5, 11],
      );
      for (const frame of witness.frames) {
        const base = join(output, `${name}-witness`, String(frame.index));
        assert.equal(await hashFile(join(base, "candidate.png")), frame.rgb.png_sha256);
        assert.equal(await hashFile(join(base, "plan.fpln")), frame.rgb.plan_sha256);
        assert.equal(await hashFile(join(base, "input.nv12")), frame.nv12_sha256);
      }
      audioExports.push({ include_audio: includeAudio, receipt, probe, witness });
    }
    const [audible, muted] = audioExports;
    assert.equal(audible.witness.project_authored_sha256, muted.witness.project_authored_sha256);
    assert.deepEqual(audible.witness.video, muted.witness.video);
    for (const [index, frame] of audible.witness.frames.entries()) {
      const other = muted.witness.frames[index];
      assert.equal(frame.time_bits, other.time_bits);
      assert.equal(frame.rgb.png_sha256, other.rgb.png_sha256, "muting changed audio-reactive RGB");
      assert.equal(
        frame.rgb.plan_sha256,
        other.rgb.plan_sha256,
        "muting changed visual evaluation",
      );
      assert.equal(frame.nv12_sha256, other.nv12_sha256, "muting changed encoder video input");
    }
    report.cases.push({ id: "audio-selection-preserves-reactive-visuals", exports: audioExports });
    context.print?.(
      "Audio selection passed: identical reactive plans, RGB and NV12; selected mux tracks",
    );
    let pauseError;
    let requestedPauses = 0;
    const pausePromises = [];
    const settledPauses = [];
    const pauseArgs = await argumentsFor("minimal-golden", "pause-resume", 100);
    const paused = await run("pause-resume", cli, pauseArgs, (value, child, rows) => {
      if (
        value.rendered_frames > 0 &&
        requestedPauses === settledPauses.length &&
        requestedPauses < 2
      ) {
        requestedPauses++;
        child.stdin.write(`${JSON.stringify({ action: "pause", request_id: requestedPauses })}\n`);
      }
      if (value.stage === "paused") {
        pausePromises.push(
          (async () => {
            assert.equal(value.request_id, requestedPauses);
            const count = rows.filter((r) => r.rendered_frames).length;
            await delay(400);
            const after = rows.filter((r) => r.rendered_frames).length;
            assert.equal(after, count, "frames advanced while paused");
            assert(count < 100);
            settledPauses.push({
              request_id: value.request_id,
              settled_frames: count,
              pause_observation_ms: 400,
            });
            child.stdin.write('{"action":"resume"}\n');
          })().catch((error) => {
            pauseError = error;
            child.stdin.write('{"action":"cancel"}\n');
          }),
        );
      }
    });
    assert.equal(paused.code, 0, paused.stdout);
    await Promise.all(pausePromises);
    if (pauseError) throw pauseError;
    assert.deepEqual(
      settledPauses.map((p) => p.request_id),
      [1, 2],
    );
    assert.deepEqual(
      paused.rows.filter((r) => r.stage === "paused").map((r) => r.request_id),
      [1, 2],
    );
    report.controls.push({
      kind: "pause-resume",
      acknowledgments: settledPauses,
      receipt: paused.rows.at(-1),
    });
    for (const action of ["cancel", "disconnect", "malformed"]) {
      const name = `paused-${action}`;
      const args = await argumentsFor("minimal-golden", name, 100);
      const result = await run(name, cli, args, (value, child) => {
        if (value.rendered_frames === 1) child.stdin.write('{"action":"pause","request_id":3}\n');
        if (value.stage === "paused") {
          if (action === "disconnect") child.stdin.end();
          else
            child.stdin.write(
              action === "cancel" ? '{"action":"cancel"}\n' : '{"action":"invalid"}\n',
            );
        }
      });
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.deepEqual(
        result.rows.filter((r) => r.stage === "paused").map((r) => r.request_id),
        [3],
      );
      assert(!(await readdir(output)).includes(`${name}.mp4`));
      assert(!(await readdir(output)).includes(`${name}-witness`));
      report.controls.push({ kind: name, result: result.rows });
    }
    context.print?.(
      "Pause acknowledgments passed: repeated pause/resume, cancellation, disconnect and invalid control",
    );
    const cancelArgs = await argumentsFor("layer-text", "cancelled", 60);
    const cancelled = await run("cancelled", cli, cancelArgs, (value, child) => {
      if (value.rendered_frames === 1) child.stdin.write('{"action":"cancel"}\n');
    });
    assert.equal(cancelled.code, 2);
    assert(!(await readdir(output)).includes("cancelled.mp4"));
    assert(!(await readdir(output)).includes("cancelled-witness"));
    report.controls.push({ kind: "cancel", result: cancelled.rows });
    const ownerArgs = await argumentsFor("owner-opening", "cancelled-owner", 60);
    const ownerCancelled = await run("cancelled-owner", cli, ownerArgs, (value, child) => {
      if (value.rendered_frames === 1) child.stdin.write('{"action":"cancel"}\n');
    });
    assert.equal(ownerCancelled.code, 2);
    assert(!(await readdir(output)).includes("cancelled-owner.mp4"));
    assert(!(await readdir(output)).includes("cancelled-owner-witness"));
    report.controls.push({ kind: "cancel-owner-audio", result: ownerCancelled.rows });
    const existing = await argumentsFor("minimal-golden", "minimal-golden"),
      hash = await hashFile(join(output, "minimal-golden.mp4"));
    const rejected = await run("existing-output", cli, existing);
    assert.equal(rejected.code, 2);
    assert.equal(await hashFile(join(output, "minimal-golden.mp4")), hash);
    report.controls.push({ kind: "existing-output-preserved" });
    const overBudget = await argumentsFor("minimal-golden", "witness-budget");
    overBudget.push("--witness-bytes", "1");
    const failed = await run("witness-budget", cli, overBudget);
    assert.equal(failed.code, 2);
    assert(!(await readdir(output)).includes("witness-budget.mp4"));
    assert(!(await readdir(output)).includes("witness-budget-witness"));
    report.controls.push({ kind: "witness-budget-abort-preserves-no-output" });
    assert(!(await readdir(output)).some((n) => n.endsWith(".tmp")));
    assert.deepEqual(await temporary(), before);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    assert.equal(await hashFile(cli), report.binary.sha256);
    await prepared.assertUnchanged();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
