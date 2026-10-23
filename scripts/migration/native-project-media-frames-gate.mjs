import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { captureSource, digest } from "../parity/provenance.mjs";
import {
  historicalProjectValidator,
  preserveFrozenProjectSource,
} from "./frozen-project-source.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Native source binding and clocks; complete project plans and pixels remain separate gates. */
export async function auditProjectMediaFrames(context, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const proof = async (path, expected) => {
    const input = await reader.bytes(local(path));
    if (expected) assert.equal(input.sha256, expected, path);
    return { path: local(path), sha256: input.sha256 };
  };
  const ledger = JSON.parse(
    await readFile(join(context.root, "docs/migration/rust-renderer-progress.json")),
  );
  const task = ledger.milestones.find((m) => m.id === "M9").tasks.find((t) => t.id === "M9-T16");
  assert.equal(task.status, "done");
  const captureProof = await proof(
    join(context.root, task.full_capture.path),
    task.full_capture.sha256,
  );
  const manifestProof = await proof(
    join(context.root, task.plan_reference_manifest.path),
    task.plan_reference_manifest.sha256,
  );
  const capture = JSON.parse((await reader.bytes(captureProof.path)).bytes);
  assert.equal(capture.status, "passed");
  assert.equal(capture.source_unchanged, true);
  // Current G2 independently decodes every frozen plan and resource closure with plan-diff.
  const { identity: validator, proof: validatorProof } = await historicalProjectValidator(
    reader,
    task.capture_validator,
    capture.source,
  );
  const frozenSource = await preserveFrozenProjectSource(context, capture.source, reader);
  const current = await captureSource(context.root);
  const historicalPaths = new Set(capture.source.files.map((file) => file.path));
  // The retained TS reference keeps its original bridge identity. Fresh native candidate
  // execution must not claim that a rebuilt bridge produced those frozen observations.
  assert.equal(
    capture.source.renderer_source_sha256,
    digest({
      files: capture.source.files,
      bridge_sha256: capture.source.bridge_sha256,
      ir_cli_sha256: validator.sha256,
    }),
  );
  assert.deepEqual(capture.source_after, capture.source);
  const sources = [captureProof, manifestProof, ...(validatorProof ? [validatorProof] : [])];
  const candidateAdditions = [];
  for (const file of current.files.filter((file) => !historicalPaths.has(file.path))) {
    const entry = await proof(join(context.root, file.path), file.sha256);
    candidateAdditions.push(entry);
    sources.push(entry);
  }
  for (const file of frozenSource.files)
    sources.push(await proof(join(context.root, file.path), file.sha256));
  const manifest = JSON.parse((await reader.bytes(manifestProof.path)).bytes);
  assert.equal(manifest.kind, "ts-plan-reference");
  assert.equal(manifest.scope, "full");
  assert.equal(manifest.source_verified, true);
  assert.deepEqual(manifest.source, capture.source);
  assert.deepEqual(manifest.source_after, capture.source);
  const base = dirname(join(context.root, manifestProof.path));
  const cases = [];
  for (const entry of manifest.cases) {
    const caseFile = await proof(join(base, entry.id, "capture.json"), entry.capture_sha256);
    const record = JSON.parse((await reader.bytes(caseFile.path)).bytes);
    let path =
      record.inputs.case.project === "env:ASTER_PERF_PROJECT"
        ? context.env.ASTER_PERF_PROJECT
        : join(context.root, record.inputs.case.project);
    assert(path);
    if ((await stat(path)).isDirectory()) path = join(path, "project.json");
    const raw = await readFile(path);
    assert.equal(sha256(raw), record.inputs.project_sha256);
    if (
      !JSON.parse(raw).sources?.some((source) =>
        ["still", "video", "imageSequence"].includes(source.kind),
      )
    )
      continue;
    const project = {
      path: isAbsolute(path) ? path : join(context.root, path),
      sha256: sha256(raw),
    };
    let scope;
    const samples = [];
    for (const sample of record.samples) {
      const index = sample.sample.index;
      const metaProof = await proof(
        join(base, entry.id, String(index), "meta.json"),
        sample.meta_sha256,
      );
      const meta = JSON.parse((await reader.bytes(metaProof.path)).bytes);
      assert.equal(meta.frame_plan.ir_cli_sha256, validator.sha256);
      assert.equal(meta.time, sample.sample.time);
      const resources = await proof(
        join(base, entry.id, String(index), "resources.json"),
        meta.frame_plan.files["resources.json"],
      );
      const messages = JSON.parse((await reader.bytes(resources.path)).bytes);
      const source = messages.find(
        (m) => m.kind === "media_source" && m.descriptor.media_kind !== "raster",
      );
      if (source) {
        scope ??= source.descriptor.authorization_scope;
        assert.equal(scope, source.descriptor.authorization_scope);
      }
      samples.push({ index, time: sample.sample.time, resources });
    }
    if (scope) {
      cases.push({
        id: entry.id,
        project,
        composition: record.inputs.case.composition,
        scope,
        samples,
      });
      sources.push(caseFile);
    }
  }
  assert(cases.length > 0);
  const input = {
    cases,
    sources,
    ffmpeg: await proof(join(context.root, "build/ffmpeg/ffmpeg.exe")),
    ffprobe: await proof(join(context.root, "build/ffmpeg/ffprobe.exe")),
  };
  const steps = [];
  let observations;
  for (const control of [null, "wrong-time", "stale-project"]) {
    const value = structuredClone(input);
    if (control) {
      const item = value.cases.find((c) => c.id.startsWith("video-"));
      assert(item);
      value.cases = [item];
      item.samples = item.samples.slice(0, 1);
      if (control === "wrong-time") item.samples[0].time += 0.01;
      else item.project.sha256 = "0".repeat(64);
    }
    const inputPath = join(context.output, `project-media-frames-${control ?? "oracle"}.json`);
    const outputPath = join(
      context.output,
      `project-media-frames-${control ?? "oracle"}-observations.json`,
    );
    await writeAtomicJson(inputPath, value);
    await proof(inputPath);
    const step = await execute(
      {
        id: `native-project-media-frames-${control ?? "parity"}`,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-media-native",
          "--test",
          "project_oracle",
          "native_project_media_matches_published_descriptors",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      {
        ...context,
        env: {
          ...context.env,
          ASTER_PROJECT_MEDIA_FRAMES: inputPath,
          ASTER_PROJECT_MEDIA_FRAMES_REPORT: outputPath,
          ASTER_PROJECT_MEDIA_PLAN_ONLY: "1",
        },
      },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.exit_code, control ? 101 : 0);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      control
        ? /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log)
        : /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log),
    );
    if (!control) {
      observations = await proof(outputPath);
      const report = JSON.parse((await reader.bytes(observations.path)).bytes);
      assert.equal(report.decoded_pixels, false);
      assert(report.observations.length > 0 && report.observations.every((o) => o.matched));
      observations.count = report.observations.length;
    }
  }
  return {
    status: "passed",
    scope: "native-root-file-media-descriptors",
    whole_corpus_native_plan_acceptance: false,
    reference: {
      capture: captureProof,
      manifest: manifestProof,
      renderer_source_sha256: capture.source.renderer_source_sha256,
      bridge_sha256: capture.source.bridge_sha256,
      validator,
      frozen_source: frozenSource,
      current_ts_files_match: frozenSource.current_ts_files_match,
      plan_validation: "Every reference is independently decoded by the current G2 plan-diff",
    },
    candidate_execution: "fresh-native-project-media-test",
    candidate_additions: candidateAdditions,
    current_bridge_sha256: current.bridge_sha256,
    cases: cases.length,
    samples: cases.reduce((n, c) => n + c.samples.length, 0),
    observations,
    steps,
    checked_files: await reader.stable(),
  };
}
