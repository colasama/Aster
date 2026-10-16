import assert from "node:assert/strict";
import test from "node:test";
import {
  assessNativeExportCompletion,
  assessNativeQualityDiagnostic,
  nativeExportRequirements,
  recordNativeExportCoverage,
} from "./native-export-gate.mjs";

test("final export acceptance requires authenticated complete coverage and every independent lane", () => {
  const evidence = { path: "checkpoint.json", sha256: "a".repeat(64) };
  const report = {
    source_unchanged: true,
    coverage: {
      corpus: [
        { id: "owner-main", status: "passed", evidence },
        { id: "sample", status: "passed", evidence },
      ],
      owner: { status: "passed" },
      lifecycle: { status: "passed" },
    },
    diagnostics: ["root", "recursive"].map((mode) => ({
      mode,
      status: "passed",
      self_review: { status: "passed" },
    })),
  };
  const schedule = {
    status: "passed",
    full_coverage: true,
    source_unchanged: true,
    cases: report.coverage.corpus.map(({ id }) => ({
      id,
      authenticated: true,
      result: {},
      checkpoint: evidence,
    })),
  };
  assert.deepEqual(assessNativeExportCompletion(report, schedule), {
    status: "passed",
    full_coverage: true,
    native_export_acceptance: true,
  });
  for (const mutate of [
    (_r, s) => {
      s.cases.pop();
    },
    (_r, s) => {
      s.full_coverage = false;
    },
    (_r, s) => {
      s.source_unchanged = false;
    },
    (_r, s) => {
      s.cases[0].authenticated = false;
    },
    (_r, s) => {
      s.cases[0].checkpoint = null;
    },
    (_r, s) => {
      s.status = "failed";
    },
    (r) => {
      r.source_unchanged = false;
    },
    (r) => {
      r.coverage.corpus[0].status = "failed";
    },
    (r) => {
      r.coverage.corpus[1].evidence = null;
    },
    (r) => {
      r.coverage.owner.status = "missing";
    },
    (r) => {
      r.coverage.lifecycle.status = "failed";
    },
    (r) => {
      r.diagnostics.pop();
    },
    (r) => {
      r.diagnostics[0].self_review.status = "awaiting-self-review";
    },
    (r) => {
      r.diagnostics[1].status = "failed";
    },
  ]) {
    const r = structuredClone(report),
      s = structuredClone(schedule);
    mutate(r, s);
    assert.equal(assessNativeExportCompletion(r, s).native_export_acceptance, false);
  }
  schedule.cases[1].id = "owner-main";
  assert.throws(() => assessNativeExportCompletion(report, schedule));
  schedule.cases[1].id = "unexpected";
  assert.throws(() => assessNativeExportCompletion(report, schedule));
});

test("owner coverage rejects shortened, shifted, silent and identity-unchecked exports", () => {
  const frames = Array.from({ length: 300 }, (_, index) => 714 + index);
  const coverage = () =>
    nativeExportRequirements({ schemaVersion: 1, cases: [{ id: "owner-main", frames }] });
  const entry = {
    id: "owner-main",
    frames,
    frame_count: 300,
    status: "failed",
    outputs: Object.fromEntries(
      ["native", "ts"].map((arm) => [
        arm,
        { audiovisual: { required_audio: true, frame_count: 300 } },
      ]),
    ),
    audio: { passed: true },
    quality: { passed: false },
    comparisons: ["native", "ts"].flatMap((name) =>
      frames.map((frame) => ({
        name,
        sequence: { frame },
        checks: [{ id: "frame_identity", passed: true }],
      })),
    ),
  };
  const result = coverage();
  recordNativeExportCoverage(result, entry, { path: "report.json" });
  assert.equal(result.owner.status, "failed");
  assert.equal(result.corpus[0].status, "failed");
  for (const mutate of [
    (e) => e.frames.pop(),
    (e) => {
      e.frame_count--;
    },
    (e) => {
      e.outputs.native.audiovisual.required_audio = false;
    },
    (e) => {
      e.comparisons[0].sequence.frame++;
    },
    (e) => {
      e.comparisons[0].checks = [];
    },
    (e) => {
      e.audio = null;
    },
    (e) => {
      e.quality = null;
    },
    (e) => {
      e.status = "passed";
    },
  ]) {
    const invalid = structuredClone(entry);
    mutate(invalid);
    assert.throws(() => recordNativeExportCoverage(coverage(), invalid, {}));
  }
});

function diagnostic() {
  return {
    status: "diagnostic",
    production_route: true,
    quality_controls: [],
    source_unchanged: true,
    vmaf: { native: 96, ts: 97 },
    comparisons: ["native", "ts"].flatMap((name) =>
      [0, 1, 2].map((index) => ({
        name,
        index,
        passed: true,
        metrics: { exact: false },
        structural: { largest_error_component: 0, ink_bounds: {} },
        sequence: { frame: index, first_frame: 0, last_frame: 2 },
        isolated: true,
        checks: [
          { id: "frame_identity", passed: true },
          { id: "ink_bounds", passed: true },
        ],
        step: { status: "passed", exit_code: 0 },
      })),
    ),
  };
}

test("fallback diagnostic recomputes both relative thresholds without bypassing pixel checks", () => {
  const report = diagnostic();
  delete report.vmaf;
  report.quality = {
    method: "ssim-psnr",
    ssim: { native: 0.999, ts: 1 },
    psnr: { native: 41, ts: 41.4 },
    passed: true,
  };
  assert.equal(assessNativeQualityDiagnostic(report).status, "passed");
  report.quality.psnr.native = 40.8;
  assert.equal(assessNativeQualityDiagnostic(report).status, "failed");
  report.quality.psnr.native = 41;
  report.quality.ssim.native = 0.997;
  assert.equal(assessNativeQualityDiagnostic(report).status, "failed");
});

test("relative quality cannot hide absolute pixel failures or grant export acceptance", () => {
  const report = diagnostic();
  assert.deepEqual(assessNativeQualityDiagnostic(report), {
    status: "passed",
    absolute_pixels_passed: true,
    relative_quality_passed: true,
    failed_native_frames: [],
    self_review: "required-separately",
    native_export_acceptance: false,
  });
  report.comparisons[1].passed = false;
  report.comparisons[1].checks.push({ id: "psnr", passed: false });
  report.comparisons[1].step = { status: "failed", exit_code: 1 };
  const failed = assessNativeQualityDiagnostic(report);
  assert.equal(failed.status, "failed");
  assert.equal(failed.relative_quality_passed, true);
  assert.deepEqual(failed.failed_native_frames, [1]);
  report.vmaf.native = 95.9;
  report.relative_quality_passed = true;
  assert.equal(assessNativeQualityDiagnostic(report).relative_quality_passed, false);
});

test("incomplete, duplicate, stale, tuned and non-production quality evidence is rejected", () => {
  for (const mutate of [
    (r) => {
      r.comparisons.pop();
    },
    (r) => {
      r.comparisons[1].index = 0;
    },
    (r) => {
      r.comparisons[0].step.exit_code = 1;
    },
    (r) => {
      r.comparisons[0].structural = null;
    },
    (r) => {
      r.comparisons[0].sequence = null;
    },
    (r) => {
      r.comparisons[0].sequence.frame = 2;
    },
    (r) => {
      r.comparisons[0].structural.ink_bounds = null;
    },
    (r) => {
      r.comparisons[0].checks.pop();
    },
    (r) => {
      r.production_route = false;
    },
    (r) => {
      r.quality_controls = ["--encoder-quality-vs-speed", "100"];
    },
    (r) => {
      r.source_unchanged = false;
    },
    (r) => {
      r.vmaf.native = NaN;
    },
    (r) => {
      r.status = "failed";
    },
  ]) {
    const report = diagnostic();
    mutate(report);
    assert.throws(() => assessNativeQualityDiagnostic(report));
  }
});

test("diagnostic success never fills required corpus, owner or lifecycle coverage", () => {
  const corpus = {
    schemaVersion: 1,
    cases: [
      { id: "minimal", frames: [0, 5, 9] },
      { id: "effects", frames: [0, 1] },
    ],
  };
  const coverage = nativeExportRequirements(corpus);
  assert.equal(assessNativeQualityDiagnostic(diagnostic()).status, "passed");
  assert(coverage.corpus.every((entry) => entry.status === "missing"));
  assert.equal(coverage.owner.status, "missing");
  assert.equal(coverage.lifecycle.status, "missing");
  corpus.cases[0].frames[0] = 2;
  assert.deepEqual(coverage.corpus[0].frames, [0, 5, 9]);
  assert.throws(() => nativeExportRequirements({ schemaVersion: 1, cases: [] }));
  assert.throws(() =>
    nativeExportRequirements({ schemaVersion: 1, cases: [corpus.cases[0], corpus.cases[0]] }),
  );
  assert.throws(() =>
    nativeExportRequirements({ schemaVersion: 1, cases: [{ id: "bad", frames: [0, 0] }] }),
  );
});
