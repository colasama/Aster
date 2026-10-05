import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAtomicJson } from "../migration/report.mjs";
import { hashFile } from "../migration/source.mjs";
import { publishCandidateCapture } from "./candidate-capture.mjs";
import { CaptureStore } from "./capture-store.mjs";
import { PixelInputs } from "./pixel-inputs.mjs";
import { digest } from "./provenance.mjs";

async function fixture(t, subset = false) {
  const root = await mkdtemp(join(tmpdir(), "aster-parity-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = ["sequence", "static"].map((id) => ({
    id,
    project: `${id}.json`,
    composition: id,
    size: { width: 1, height: 1 },
    frames: id === "sequence" ? [0, 2] : [0],
    aa: "off",
    features: [],
    tolerance: "exact",
    ...(id === "sequence" ? { sequence: true } : {}),
  }));
  await writeAtomicJson(join(root, "tests", "parity", "corpus.json"), { cases });
  await writeAtomicJson(join(root, "tests", "parity", "tolerances.json"), { schema_version: 1 });
  await writeAtomicJson(join(root, "docs", "migration", "rust-renderer-progress.json"), {
    reference_baseline: { renderer_source_sha256: "b".repeat(64) },
  });
  const config = {
    root,
    runId: "test",
    runDirectory: join(root, "artifacts", "parity", "runs", "test"),
    candidate: true,
    source: {
      commit: "test",
      dirty: true,
      renderer_source_sha256: "a".repeat(64),
      tree_sha256: "c".repeat(64),
    },
    assignments: cases.slice(0, subset ? 1 : 2).map((item) => {
      const frames = item.sequence ? [0, 2, 1, 3] : [0];
      const inputs = { case: item, frames, project_sha256: "d".repeat(64) };
      return { case: item, frames, inputs, caseHash: digest(inputs) };
    }),
  };
  const host = {
    backend: "browser-webgpu",
    cacheIdentity: {
      adapter: "test",
      fonts: { status: "available", sha256: "e".repeat(64), count: 1 },
    },
  };
  const store = new CaptureStore(config, host);
  for (const assignment of config.assignments) {
    for (const frame of assignment.frames)
      await store.writeFrame(assignment, {
        caseId: assignment.case.id,
        frame,
        time: frame / 30,
        frameRate: { numerator: 30, denominator: 1 },
        width: 1,
        height: 1,
        pixels: new Uint8Array([frame, 81, 139, 0]),
        diagnostics: {},
        timings: {},
      });
    await store.completeCase(assignment, { caseId: assignment.case.id, elapsed_ms: 1 });
  }
  const report = {
    status: "passed",
    source_unchanged: true,
    exit_code: 0,
    run_id: config.runId,
    source: config.source,
    source_after: structuredClone(config.source),
    selected_cases: config.assignments.map((item) => item.case.id),
    cases: config.assignments.map((item) => ({ id: item.case.id, status: "passed" })),
    host,
  };
  const pending = join(config.runDirectory, "pending");
  const destination = join(config.runDirectory, "candidate");
  return { root, config, report, pending, destination };
}

async function changeMeta(data, edit) {
  const path = join(data.pending, "sequence", "0", "meta.json");
  const meta = JSON.parse(await readFile(path, "utf8"));
  edit(meta);
  await writeAtomicJson(path, meta);
  const capturePath = join(data.pending, "sequence", "capture.json");
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  capture.frames[0].meta_sha256 = await hashFile(path);
  await writeAtomicJson(capturePath, capture);
}

test("required submitted-plan evidence cannot be omitted from candidate publication", async (t) => {
  const data = await fixture(t);
  data.config.requireFrameBundles = true;
  await assert.rejects(
    publishCandidateCapture(data.config, data.report),
    /Missing submitted frame artifact/,
  );
  await assert.rejects(lstat(data.destination), { code: "ENOENT" });
});

test("fresh candidates publish atomically with complete provenance and requested-only gate manifest", async (t) => {
  const data = await fixture(t);
  const reference = join(data.root, "artifacts", "parity", "reference", "sequence");
  await mkdir(reference, { recursive: true });
  await writeFile(join(reference, "sentinel"), "preserved TS oracle");
  const published = await publishCandidateCapture(data.config, data.report);
  assert.equal(await readFile(join(reference, "sentinel"), "utf8"), "preserved TS oracle");
  assert.deepEqual(published, {
    manifest: "artifacts/parity/runs/test/candidate/manifest.json",
    manifest_sha256: await hashFile(join(data.destination, "manifest.json")),
    scope: "full",
    case_count: 2,
    requested_frame_count: 3,
    captured_frame_count: 5,
  });
  await assert.rejects(lstat(data.pending), { code: "ENOENT" });
  const manifestPath = join(data.root, published.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.kind, "ts-candidate");
  assert.equal(manifest.source_verified, true);
  assert.deepEqual(manifest.source, data.config.source);
  assert.deepEqual(manifest.host, data.report.host);
  assert.equal(manifest.required_case_count, 2);
  assert.equal(manifest.required_frame_count, 3);
  assert.deepEqual(
    manifest.frames.map((frame) => [frame.case_id, frame.frame]),
    [
      ["sequence", 0],
      ["sequence", 2],
      ["static", 0],
    ],
  );
  for (const item of manifest.cases) {
    const path = join(data.destination, item.path);
    assert.equal(await hashFile(path), item.capture_sha256);
    const capture = JSON.parse(await readFile(path, "utf8"));
    assert.equal(capture.source_verified, true);
    assert.deepEqual(
      capture.frames.map((frame) => frame.frame),
      item.captured_frames,
    );
  }
  for (const frame of manifest.frames) {
    assert.equal(await hashFile(join(data.destination, frame.path)), frame.png_sha256);
    assert.equal(await hashFile(join(data.destination, frame.meta_path)), frame.meta_sha256);
  }
  const inputs = new PixelInputs({ root: data.root });
  assert.equal((await inputs.load(manifestPath, "full", "exact")).length, 3);
});

test("a selected subset is explicitly diagnostic and cannot satisfy full gate coverage", async (t) => {
  const data = await fixture(t, true);
  const published = await publishCandidateCapture(data.config, data.report);
  assert.equal(published.scope, "diagnostic");
  const inputs = new PixelInputs({ root: data.root });
  await assert.rejects(
    inputs.load(join(data.root, published.manifest), "full", "exact"),
    /missing required frames/,
  );
});

for (const scenario of ["failed", "changed", "exit", "source", "missing", "cached", "duplicate"]) {
  test(`candidate publication rejects ${scenario} run without exposing a manifest`, async (t) => {
    const data = await fixture(t);
    if (scenario === "failed") data.report.status = "failed";
    if (scenario === "changed") data.report.source_unchanged = false;
    if (scenario === "exit") data.report.exit_code = 1;
    if (scenario === "source") data.report.source_after.renderer_source_sha256 = "f".repeat(64);
    if (scenario === "missing") data.report.cases.pop();
    if (scenario === "cached") data.report.cases[0].status = "cached";
    if (scenario === "duplicate") data.config.assignments.push(data.config.assignments[0]);
    await assert.rejects(publishCandidateCapture(data.config, data.report));
    await assert.rejects(lstat(data.destination), { code: "ENOENT" });
  });
}

for (const scenario of ["png", "meta", "source", "host", "rgba", "time", "neighbor"]) {
  test(`candidate publication rejects ${scenario} evidence corruption`, async (t) => {
    const data = await fixture(t);
    if (scenario === "png")
      await writeFile(join(data.pending, "sequence", "0", "frame.png"), "bad");
    if (scenario === "meta")
      await writeFile(join(data.pending, "sequence", "0", "meta.json"), "{}");
    if (scenario === "source")
      await changeMeta(data, (meta) => {
        meta.renderer_source_sha256 = "f".repeat(64);
      });
    if (scenario === "host")
      await changeMeta(data, (meta) => {
        meta.host.backend = "other";
      });
    if (scenario === "rgba")
      await changeMeta(data, (meta) => {
        meta.rgba_sha256 = "0".repeat(64);
      });
    if (scenario === "time")
      await changeMeta(data, (meta) => {
        meta.time = 1;
      });
    if (scenario === "neighbor") await rm(join(data.pending, "sequence", "3", "frame.png"));
    await assert.rejects(publishCandidateCapture(data.config, data.report));
    await assert.rejects(lstat(data.destination), { code: "ENOENT" });
  });
}

test("candidate outputs cannot overwrite an existing bundle or redirect the run into references", async (t) => {
  const data = await fixture(t);
  await mkdir(data.destination);
  await writeFile(join(data.destination, "sentinel"), "existing candidate");
  await assert.rejects(publishCandidateCapture(data.config, data.report), /already exists/);
  assert.equal(await readFile(join(data.destination, "sentinel"), "utf8"), "existing candidate");
  const reference = join(data.root, "artifacts", "parity", "reference");
  await mkdir(reference, { recursive: true });
  await assert.rejects(
    publishCandidateCapture({ ...data.config, runDirectory: reference }, data.report),
    /independent run directory/,
  );
});

test("a junction to evidence outside staging is rejected before publication", async (t) => {
  const data = await fixture(t);
  const frame = join(data.pending, "sequence", "3");
  const outside = join(data.config.runDirectory, "outside");
  await rename(frame, outside);
  await symlink(outside, frame, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishCandidateCapture(data.config, data.report), /escapes/);
  await assert.rejects(lstat(data.destination), { code: "ENOENT" });
});
