import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditExportLifecycle } from "./native-export-lifecycle.mjs";
import { hashFile } from "./source.mjs";

test("lifecycle reuse authenticates source, files, pause progress and cancellation cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { source_sha256: "current-source" };
  const save = async (path, content) => {
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return { path, sha256: await hashFile(path) };
  };
  await mkdir(join(root, "target/release"), { recursive: true });
  const binary = await save(join(root, "target/release/aster-render-cli.exe"), "binary");
  const compiler = await save(join(root, "compiler"), "compiler");
  const ffprobe = await save(join(root, "ffprobe"), "probe");
  const packagedApp = await save(join(root, "app.asar"), "app");
  const capture = await save(join(root, "capture.json"), { status: "passed", source });
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const jobs = [];
  for (const scenario of [
    "complete",
    "audio",
    "pause-export",
    "cancel-preflight",
    "cancel-export",
    "fallback",
  ]) {
    const directory = join(root, scenario);
    await mkdir(directory);
    const previous = await save(join(directory, "output.mp4"), "previous");
    const cancelled = scenario.startsWith("cancel");
    const frameCount = scenario === "pause-export" ? 120 : 12;
    const output = cancelled ? previous : await save(previous.path, "complete video");
    jobs.push({
      scenario,
      frame_count: frameCount,
      status: cancelled ? "cancelled" : "completed",
      progress: { completedFrames: cancelled ? 1 : frameCount },
      route: { renderer: scenario === "fallback" ? "ts" : "rust" },
      states: [{ status: "paused", frames: 1 }],
      paused: { frames_before: 1, frames_after: 1, destination_sha256: previous.sha256 },
      probe: { streams: [{ codec_type: "video", nb_read_frames: String(frameCount) }] },
      files: {
        destination: output.path,
        destination_sha256: output.sha256,
        previous_sha256: previous.sha256,
        directory,
        entries: ["output.mp4"],
        temporary_root: temporary,
        temporary_entries: [],
        active_hosts: 0,
      },
    });
  }
  const queue = { status: "passed", source, capture, runtime: { binary, compiler, ffprobe }, jobs };
  const queueEvidence = await save(join(root, "queue.json"), queue);
  const app = {
    id: "G6",
    status: "passed",
    source,
    source_after: source,
    source_unchanged: true,
    application: { status: "passed" },
    packaged_app: packagedApp,
    packaged_renderer: binary,
    capture,
    queue_evidence: queueEvidence,
    queue,
  };
  const evidence = await save(join(root, "app.json"), app);
  const context = { root, source };
  assert.equal((await auditExportLifecycle(context, evidence)).status, "passed");
  assert.equal((await auditExportLifecycle(context)).status, "failed");
  assert.match(
    (await auditExportLifecycle({ ...context, source: { source_sha256: "new-source" } }, evidence))
      .error,
    /Stale application/,
  );
  for (const mutate of [
    (value) => {
      value.source_unchanged = false;
    },
    (value) => {
      value.queue.jobs[2].paused.frames_after = 2;
    },
    (value) => {
      value.queue.jobs[4].files.previous_sha256 = "a".repeat(64);
    },
    (value) => {
      value.queue.jobs[4].route.renderer = "ts";
    },
    (value) => {
      value.queue.jobs.pop();
    },
    (value) => {
      value.queue.capture.sha256 = "a".repeat(64);
    },
  ]) {
    const changed = structuredClone(app);
    mutate(changed);
    changed.queue_evidence = await save(queueEvidence.path, changed.queue);
    const changedEvidence = await save(evidence.path, changed);
    assert.equal((await auditExportLifecycle(context, changedEvidence)).status, "failed");
  }
  await save(queueEvidence.path, queue);
  await save(evidence.path, app);
  assert.equal((await auditExportLifecycle(context, evidence)).status, "passed");
  await writeFile(join(temporary, "leftover.tmp"), "partial");
  assert.equal((await auditExportLifecycle(context, evidence)).status, "failed");
  await rm(join(temporary, "leftover.tmp"));
  for (const path of [
    packagedApp.path,
    binary.path,
    capture.path,
    queueEvidence.path,
    jobs[4].files.destination,
    evidence.path,
  ]) {
    const original = await readFile(path);
    await writeFile(path, "changed");
    assert.match(
      (await auditExportLifecycle(context, evidence)).error,
      /Changed lifecycle evidence/,
    );
    await writeFile(path, original);
  }
});
