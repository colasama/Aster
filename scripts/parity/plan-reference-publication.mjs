import assert from "node:assert/strict";
import { lstat, readFile, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { writeAtomicJson } from "../migration/report.mjs";
import { artifactHash, validateFrameArtifacts } from "./frame-artifacts.mjs";
import { readPlanProjectSnapshot } from "./plan-project-snapshot.mjs";
import { validatePlanSampleSchedule } from "./plan-samples.mjs";
import { digest } from "./provenance.mjs";

/** Authenticate all samples before atomically publishing an isolated plan-reference run. */
export async function publishPlanReferences(config, report) {
  assert.equal(config.planReferences, true);
  assert.equal(report.status, "passed");
  assert.equal(report.source_unchanged, true);
  assert.equal(report.exit_code, 0);
  assert.equal(report.run_id, config.runId);
  assert.deepEqual(report.source, config.source);
  assert.equal(report.source_after.tree_sha256, config.source.tree_sha256);
  assert.equal(report.source_after.renderer_source_sha256, config.source.renderer_source_sha256);
  assert(
    report.host?.cacheIdentity?.fonts?.status === "available",
    "Plan references require stable fonts",
  );
  const directory = await realpath(config.runDirectory);
  const expected = join(await realpath(config.root), "artifacts", "parity", "runs", config.runId);
  assert.equal(relative(expected, directory), "", "Plan reference publication escaped its run");
  const pending = await realpath(join(directory, "pending"));
  assert.equal(relative(join(directory, "pending"), pending), "");
  const destination = join(directory, "plan-reference");
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const corpusBytes = await readFile(join(config.root, "tests", "parity", "corpus.json"));
  const corpus = JSON.parse(corpusBytes);
  const selected = config.assignments.map((a) => a.case.id);
  assert(selected.length > 0 && new Set(selected).size === selected.length);
  assert.deepEqual(report.selected_cases, selected);
  assert.deepEqual(report.cases.map((c) => c.id).sort(), [...selected].sort());
  assert(report.cases.every((c) => c.status === "passed"));
  const manifest = {
    schema_version: 1,
    kind: "ts-plan-reference",
    source_verified: true,
    scope: selected.length === corpus.cases.length ? "full" : "diagnostic",
    source: config.source,
    source_after: report.source_after,
    host: report.host,
    run_id: config.runId,
    corpus_sha256: artifactHash(corpusBytes),
    required_cases: corpus.cases.length,
    random_times_per_case: 64,
    captured_samples: 0,
    cases: [],
  };
  for (const assignment of config.assignments) {
    const item = assignment.case;
    assert(/^[a-z0-9-]+$/.test(item.id));
    assert.deepEqual(
      item,
      corpus.cases.find((c) => c.id === item.id),
    );
    assert.equal(assignment.caseHash, digest(assignment.inputs));
    assert.deepEqual(assignment.planSamples, assignment.inputs.plan_samples);
    assert.deepEqual(assignment.frames, assignment.inputs.frames);
    const caseDirectory = await realpath(join(pending, item.id));
    assert.equal(relative(join(pending, item.id), caseDirectory), "");
    const read = async (name) => {
      const path = await realpath(join(caseDirectory, name));
      const member = relative(caseDirectory, path);
      assert(member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member));
      assert((await lstat(path)).isFile());
      return readFile(path);
    };
    const captureBytes = await read("capture.json");
    const capture = JSON.parse(captureBytes);
    assert.equal(capture.kind, "ts-plan-reference");
    assert.equal(capture.case_id, item.id);
    assert.equal(capture.source_verified, false);
    assert.deepEqual(capture.inputs, assignment.inputs);
    const projectBytes = await readPlanProjectSnapshot(config, item, capture, read);
    assert.equal(artifactHash(projectBytes), capture.project_sha256);
    const project = JSON.parse(projectBytes);
    const composition = project.compositions.find((c) => c.id === item.composition);
    validatePlanSampleSchedule(
      assignment.planSamples,
      item,
      composition,
      assignment.inputs.project_sha256,
    );
    assert.deepEqual(
      assignment.frames,
      assignment.planSamples.samples.map((s) => s.index),
    );
    assert.equal(capture.samples.length, assignment.frames.length);
    const resources = new Map();
    for (const [index, entry] of capture.samples.entries()) {
      const sample = assignment.planSamples.samples[index];
      assert.equal(entry.frame, index);
      assert.deepEqual(entry.sample, sample);
      const bytes = await read(`${index}/meta.json`);
      assert.equal(artifactHash(bytes), entry.meta_sha256);
      const meta = JSON.parse(bytes);
      assert.equal(meta.kind, "ts-plan-sample");
      assert.equal(meta.frame, index);
      assert.equal(meta.case_id, item.id);
      assert.equal(meta.case_sha256, assignment.caseHash);
      assert.equal(meta.project_sha256, capture.project_sha256);
      assert.equal(meta.renderer_source_sha256, config.source.renderer_source_sha256);
      assert.deepEqual(meta.sample, sample);
      assert.equal(meta.time, sample.time);
      assert.deepEqual(meta.frame_rate, assignment.planSamples.frame_rate);
      await validateFrameArtifacts(read, meta, item, config.source, resources, {
        requirePixelReplay: false,
      });
    }
    manifest.captured_samples += capture.samples.length;
    manifest.cases.push({
      id: item.id,
      capture_sha256: artifactHash(captureBytes),
      project_sha256: capture.project_sha256,
      project_snapshot: capture.project_snapshot,
      samples: capture.samples.length,
      case_sha256: assignment.caseHash,
    });
  }
  await writeAtomicJson(join(pending, "manifest.json"), manifest);
  await rename(pending, destination);
  return {
    manifest: join(destination, "manifest.json"),
    scope: manifest.scope,
    samples: manifest.captured_samples,
  };
}
