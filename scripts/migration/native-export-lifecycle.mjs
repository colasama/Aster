import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashFile } from "./source.mjs";

/** Reuse authenticated same-source packaged queue evidence without rerunning the application. */
export async function auditExportLifecycle(context, evidence) {
  const result = { status: "failed", evidence, native_export_acceptance: false };
  try {
    assert(evidence, "Current packaged application evidence is required");
    const checked = [];
    const authenticate = async (entry) => {
      assert(entry?.path && /^[a-f0-9]{64}$/.test(entry.sha256), "Missing evidence identity");
      const path = resolve(context.root, entry.path);
      assert.equal(await hashFile(path), entry.sha256, `Changed lifecycle evidence: ${entry.path}`);
      checked.push({ path, sha256: entry.sha256 });
      return path;
    };
    const app = JSON.parse(await readFile(await authenticate(evidence), "utf8"));
    assert.equal(app.id, "G6");
    assert.equal(app.status, "passed", app.error);
    assert.equal(app.application.status, "passed");
    assert.equal(app.source_unchanged, true);
    const sourceHash = context.source.source_sha256;
    assert.equal(app.source.source_sha256, sourceHash, "Stale application sources");
    assert.equal(app.source_after.source_sha256, sourceHash);
    await authenticate(app.packaged_app);
    await authenticate(app.packaged_renderer);
    assert.equal(
      app.packaged_renderer.sha256,
      await hashFile(join(context.root, "target/release/aster-render-cli.exe")),
    );
    const capturePath = await authenticate(app.capture);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.status, "passed");
    assert.equal(capture.source.source_sha256, sourceHash, "Stale queue capture");
    const queue = JSON.parse(await readFile(await authenticate(app.queue_evidence), "utf8"));
    assert.deepEqual(queue, app.queue, "Embedded queue differs from saved evidence");
    assert.equal(queue.status, "passed");
    assert.equal(queue.source.source_sha256, sourceHash);
    assert.equal(resolve(queue.capture.path), capturePath);
    assert.equal(queue.capture.sha256, app.capture.sha256);
    assert.equal(queue.runtime.binary.sha256, app.packaged_renderer.sha256);
    for (const name of ["binary", "compiler", "ffprobe"]) await authenticate(queue.runtime[name]);
    assert.deepEqual(
      queue.jobs.map((job) => job.scenario),
      ["complete", "audio", "pause-export", "cancel-preflight", "cancel-export", "fallback"],
    );
    for (const job of queue.jobs) {
      const cancelled = job.scenario.startsWith("cancel");
      const frameCount = job.scenario === "pause-export" ? 120 : 12;
      assert.equal(job.frame_count, frameCount);
      assert.equal(job.status, cancelled ? "cancelled" : "completed");
      assert.equal(job.files.active_hosts, 0);
      assert.deepEqual(job.files.entries, ["output.mp4"]);
      assert.deepEqual(job.files.temporary_entries, []);
      assert.deepEqual(await readdir(job.files.directory), job.files.entries);
      assert.deepEqual(await readdir(job.files.temporary_root), []);
      await authenticate({ path: job.files.destination, sha256: job.files.destination_sha256 });
      assert.equal(resolve(job.files.destination), resolve(job.files.directory, "output.mp4"));
      if (cancelled) {
        assert.equal(
          job.files.destination_sha256,
          job.files.previous_sha256,
          "Cancellation replaced destination",
        );
      } else {
        assert.notEqual(job.files.destination_sha256, job.files.previous_sha256);
        assert.equal(job.progress.completedFrames, frameCount);
        assert.equal(
          Number(job.probe.streams.find((stream) => stream.codec_type === "video")?.nb_read_frames),
          frameCount,
        );
      }
      if (job.scenario !== "cancel-preflight")
        assert.equal(job.route?.renderer, job.scenario === "fallback" ? "ts" : "rust");
      if (job.scenario === "cancel-export")
        assert(job.progress.completedFrames >= 1 && job.progress.completedFrames < frameCount);
      if (job.scenario === "pause-export") {
        assert(job.paused.frames_before >= 1 && job.paused.frames_before < frameCount);
        assert.equal(job.paused.frames_before, job.paused.frames_after);
        assert.equal(job.paused.destination_sha256, job.files.previous_sha256);
        assert(
          job.states.some(
            (state) => state.status === "paused" && state.frames === job.paused.frames_before,
          ),
        );
      }
    }
    for (const entry of checked)
      assert.equal(
        await hashFile(entry.path),
        entry.sha256,
        "Lifecycle evidence changed during audit",
      );
    result.status = "passed";
    result.scenarios = queue.jobs.map((job) => job.scenario);
    result.checked_files = checked;
    result.scope =
      "Packaged native pause/resume, cancellation and atomic publication; pixel, corpus, audio-content and performance acceptance remain separate";
  } catch (error) {
    result.error = error.stack ?? String(error);
  }
  return result;
}
