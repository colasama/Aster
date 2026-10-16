import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { nativeReleaseBuild } from "../native-build.mjs";
import { reviewNativeQualityDiagnostic } from "./diagnostic-quality-review.mjs";
import { auditExportQuality, exportQualityPassed } from "./export-quality.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runNativeCorpusSchedule } from "./native-corpus-schedule.mjs";
import { runNativeEncodedQualityCase } from "./native-encoded-quality-case.mjs";
import { auditExportLifecycle } from "./native-export-lifecycle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";

/** Diagnostic fixtures never satisfy corpus or owner coverage, even when every metric passes. */
export function nativeExportRequirements(corpus) {
  assert.equal(corpus.schemaVersion, 1);
  assert(Array.isArray(corpus.cases) && corpus.cases.length > 0, "Export corpus is empty");
  const ids = new Set();
  const cases = corpus.cases.map((item) => {
    assert(
      typeof item.id === "string" && item.id.length && !ids.has(item.id),
      "Duplicate or invalid export case",
    );
    ids.add(item.id);
    assert(Array.isArray(item.frames) && item.frames.length > 0);
    assert(item.frames.every((frame) => Number.isSafeInteger(frame) && frame >= 0));
    assert.equal(new Set(item.frames).size, item.frames.length);
    return {
      id: item.id,
      frames: [...item.frames],
      status: "missing",
      reason:
        "Corpus production export, decoded reference comparisons and self-review are not yet connected",
    };
  });
  return {
    corpus: cases,
    owner: {
      id: "owner-main",
      status: "missing",
      reason:
        "Complete owner export, matched encoder quality, audio synchronization and self-review are required",
    },
    lifecycle: {
      status: "missing",
      reason: "Current pause/cancel evidence must be bound to the G5 run",
    },
  };
}

/** Coverage records execution separately from the still-required pixel review. */
export function recordNativeExportCoverage(coverage, entry, evidence) {
  const required = coverage.corpus.find((item) => item.id === entry.id);
  assert(required, "Unexpected export case");
  assert.deepEqual(entry.frames, required.frames, "Export frame coverage differs");
  assert.equal(entry.frame_count, Math.max(...required.frames) - Math.min(...required.frames) + 1);
  assert(["failed", "awaiting-self-review", "passed"].includes(entry.status));
  if (entry.status === "passed") assert.equal(entry.review?.status, "passed");
  if (entry.id === "owner-main") {
    assert.equal(entry.frame_count, 300, "Owner main requires the complete 300-frame segment");
    for (const arm of ["native", "ts"]) {
      assert.equal(entry.outputs[arm].audiovisual.required_audio, true);
      assert.equal(entry.outputs[arm].audiovisual.frame_count, 300);
      const frames = entry.comparisons.filter((frame) => frame.name === arm);
      assert.deepEqual(
        frames.map((frame) => frame.sequence?.frame),
        required.frames,
      );
      assert(frames.every((frame) => frame.checks.some((check) => check.id === "frame_identity")));
    }
    assert.equal(typeof entry.audio?.passed, "boolean", "Missing owner audio content comparison");
    assert.equal(typeof entry.quality?.passed, "boolean", "Missing owner relative quality");
  }
  Object.assign(required, {
    status: entry.status,
    evidence,
    reason:
      "Actual segment exported in both arms; acceptance still requires pixel quality and self-review",
  });
  if (entry.id === "owner-main") Object.assign(coverage.owner, required);
}

/** Recompute clip verdicts; successful execution and relative VMAF cannot override pixel failures. */
export function assessNativeQualityDiagnostic(report) {
  assert.equal(report.status, "diagnostic", report.error ?? "Quality execution failed");
  assert.equal(report.production_route, true, "Quality clip bypassed whole-job admission");
  assert.deepEqual(
    report.quality_controls,
    [],
    "Tuned diagnostics are not the production configuration",
  );
  assert.equal(report.source_unchanged, true);
  assert.equal(report.comparisons.length, 6, "Incomplete encoded frame comparisons");
  for (const name of ["native", "ts"]) {
    const frames = report.comparisons.filter((frame) => frame.name === name);
    assert.deepEqual(frames.map((frame) => frame.index).sort(), [0, 1, 2]);
    for (const frame of frames) {
      assert.equal(typeof frame.passed, "boolean");
      assert.equal(frame.step.exit_code, frame.passed ? 0 : 1);
      assert.equal(frame.step.status, frame.passed ? "passed" : "failed");
      assert(frame.metrics && frame.structural, "Missing pixel or structural results");
      assert.equal(frame.sequence?.frame, frame.index, "Missing frame identity context");
      assert.equal(frame.sequence?.first_frame, 0);
      assert.equal(frame.sequence?.last_frame, 2);
      assert.equal(frame.isolated, true, "Diagnostic ink bounds were not checked");
      assert(frame.structural.ink_bounds, "Missing diagnostic ink bounds");
      assert(frame.checks.some((check) => check.id === "frame_identity"));
      assert(frame.checks.some((check) => check.id === "ink_bounds"));
      assert.equal(
        frame.passed,
        frame.checks.every((check) => check.passed),
      );
    }
  }
  const native = report.comparisons.filter((frame) => frame.name === "native");
  const absolute = native.every((frame) => frame.passed);
  const relative = exportQualityPassed(report.quality ?? { vmaf: report.vmaf });
  return {
    status: absolute && relative ? "passed" : "failed",
    absolute_pixels_passed: absolute,
    relative_quality_passed: relative,
    failed_native_frames: native.filter((frame) => !frame.passed).map((frame) => frame.index),
    self_review: "required-separately",
    native_export_acceptance: false,
  };
}

/** Every required lane must independently pass; diagnostic success never substitutes for corpus coverage. */
export function assessNativeExportCompletion(report, schedule) {
  const required = report.coverage.corpus;
  assert(required.length > 0);
  assert.equal(new Set(schedule.cases.map((c) => c.id)).size, schedule.cases.length);
  assert(
    schedule.cases.every((c) => required.some((r) => r.id === c.id)),
    "Unexpected scheduled case",
  );
  const complete =
    schedule.source_unchanged === true &&
    schedule.full_coverage === true &&
    schedule.cases.length === required.length &&
    required.every((r) =>
      schedule.cases.some(
        (c) => c.id === r.id && c.authenticated === true && c.result && c.checkpoint,
      ),
    );
  const diagnostics =
    report.diagnostics.length === 2 &&
    ["root", "recursive"].every((mode) =>
      report.diagnostics.some(
        (d) => d.mode === mode && d.status === "passed" && d.self_review?.status === "passed",
      ),
    );
  const passed =
    complete &&
    report.source_unchanged === true &&
    schedule.status === "passed" &&
    required.every((c) => c.status === "passed" && c.evidence?.sha256) &&
    report.coverage.owner.status === "passed" &&
    report.coverage.lifecycle.status === "passed" &&
    diagnostics;
  return {
    status: passed ? "passed" : "failed",
    full_coverage: complete,
    native_export_acceptance: passed,
    ...(!passed
      ? {
          error: `Native G5 requirements not satisfied: ${required.filter((c) => c.status !== "passed").length} corpus cases unaccepted; owner-main ${report.coverage.owner.status}; lifecycle ${report.coverage.lifecycle.status}; diagnostic review ${diagnostics ? "passed" : "incomplete or failed"}`,
        }
      : {}),
  };
}

/** Full production export evidence with independent corpus, diagnostic review and lifecycle lanes. */
export async function runNativeExportGate(context, execute = runStep) {
  const started = Date.now();
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    id: "G5",
    status: "failed",
    implementation: "production-corpus-checkpointed",
    full_coverage: false,
    native_export_acceptance: false,
    steps: [],
    diagnostics: [],
  };
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const corpusPath = join(root, "tests/parity/corpus.json");
    report.corpus = { path: local(corpusPath), sha256: await hashFile(corpusPath) };
    report.coverage = nativeExportRequirements(JSON.parse(await readFile(corpusPath, "utf8")));
    report.coverage.lifecycle = await auditExportLifecycle(
      { ...context, source: report.source },
      context.appEvidence,
    );
    report.owner_project = (await ownerProject(context.env)).report;
    const ledger = JSON.parse(
      await readFile(join(root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const captureDirectory = join(output, "capture");
    const resumeReader = new M0Evidence(root);
    const resumed = context.diagnosticResume
      ? await resumeReader.json(local(resolve(root, context.diagnosticResume)))
      : null;
    if (resumed) {
      assert.deepEqual(resumed.diagnostics.map((d) => d.mode).sort(), ["recursive", "root"]);
      assert.equal(resumed.execution_sha256, report.source.execution_sha256);
    }
    for (const command of [
      nativeReleaseBuild("export-renderer-build"),
      { id: "export-electron-build", file: "pnpm", args: ["electron:compile"] },
      ...(!resumed
        ? [
            {
              id: "export-quality-capture",
              file: "node",
              args: ["scripts/migration/native-media-frame-capture.mjs", captureDirectory],
              env: { ASTER_NATIVE_JOB_CAPTURE: "1" },
              timeout_ms: 300000,
            },
          ]
        : []),
    ]) {
      const step = await execute(command, context);
      report.steps.push(step);
      assert.equal(step.status, "passed", `${command.id} failed`);
    }
    const capturePath = resumed
      ? resolve(root, resumed.capture.path)
      : join(captureDirectory, "report.json");
    const capture = await resumeReader.json(local(capturePath), resumed?.capture.sha256);
    assert.equal(capture.status, "passed");
    assert.equal(capture.source.execution_sha256, report.source.execution_sha256);
    report.capture = { path: local(capturePath), sha256: await hashFile(capturePath) };
    for (const mode of ["root", "recursive"]) {
      const caseOutput = join(output, mode);
      const previous = resumed?.diagnostics.find((d) => d.mode === mode);
      const diagnostic = previous
        ? await resumeReader.json(previous.path, previous.sha256)
        : await runNativeEncodedQualityCase(
            { ...context, output: caseOutput },
            { capture: capturePath, mode },
          );
      const entry = {
        mode,
        path: previous?.path ?? local(join(caseOutput, "report.json")),
        sha256: previous?.sha256 ?? (await hashFile(join(caseOutput, "report.json"))),
        reused: Boolean(previous),
      };
      try {
        const qualityReader = new M0Evidence(root);
        await auditExportQuality(qualityReader, diagnostic.quality, 3);
        await qualityReader.stable();
        assert.equal(diagnostic.source.execution_sha256, report.source.execution_sha256);
        assert.deepEqual(diagnostic.input, report.capture);
        Object.assign(
          entry,
          await reviewNativeQualityDiagnostic(
            root,
            diagnostic,
            mode,
            ledger,
            assessNativeQualityDiagnostic(diagnostic),
          ),
        );
      } catch (error) {
        Object.assign(entry, { status: "failed", error: error.message });
      }
      report.diagnostics.push(entry);
    }
    await resumeReader.stable();
    assert(
      report.diagnostics.every((d) => d.status === "passed"),
      "Independent diagnostic review must pass before the complete corpus audit",
    );
    const corpusOutput = join(output, "corpus");
    const corpusExport = await runNativeCorpusSchedule(
      {
        ...context,
        output: corpusOutput,
        source: report.source,
      },
      { resume: context.exportResume },
    );
    report.corpus_export = {
      path: local(join(corpusOutput, "report.json")),
      sha256: await hashFile(join(corpusOutput, "report.json")),
      status: corpusExport.status,
    };
    for (const entry of corpusExport.cases) {
      if (entry.result && entry.authenticated && !entry.error)
        recordNativeExportCoverage(report.coverage, entry.result, entry.checkpoint);
      else {
        const required = report.coverage.corpus.find((c) => c.id === entry.id);
        assert(required);
        Object.assign(required, {
          status: "failed",
          reason: entry.error,
          evidence: report.corpus_export,
        });
        if (entry.id === "owner-main") Object.assign(report.coverage.owner, required);
      }
    }
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged, "Sources changed during G5 execution");
    assert.equal(await hashFile(corpusPath), report.corpus.sha256);
    Object.assign(report, assessNativeExportCompletion(report, corpusExport));
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      resume: { type: "string" },
      "app-evidence": { type: "string" },
    },
  });
  assert(values.out, "--out is required");
  const report = await runNativeExportGate({
    root: process.cwd(),
    output: resolve(values.out),
    env: process.env,
    print: console.log,
    exportResume: values.resume,
    appEvidence: values["app-evidence"]
      ? {
          path: relative(process.cwd(), resolve(values["app-evidence"])).replaceAll("\\", "/"),
          sha256: await hashFile(resolve(values["app-evidence"])),
        }
      : undefined,
  });
  console.log(JSON.stringify({ status: report.status, error: report.error }));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
