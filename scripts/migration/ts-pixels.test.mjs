import assert from "node:assert/strict";
import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { encodeRgbaPng } from "../parity/png.mjs";
import { digest } from "../parity/provenance.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { repairFixture } from "./m0-reference-repairs-fixtures.mjs";
import { auditTsCandidate } from "./ts-candidate.mjs";
import { parseTsPixelArguments, verifyTsPixels } from "./ts-pixels.mjs";

test("TS checks cannot select a partial scope or relaxed tolerance", () => {
  assert.deepEqual(parseTsPixelArguments(["--candidates", "manifest.json"]), {
    candidates: "manifest.json",
  });
  for (const args of [
    [],
    ["--candidates"],
    ["--candidates", "--exact"],
    ["--case", "one"],
    ["--candidates", "manifest.json", "--tolerance", "gpu"],
  ])
    assert.throws(() => parseTsPixelArguments(args));
});

async function candidateFixture(t) {
  const f = await repairFixture(t);
  const candidates = "snapshots/repair/manifest.json";
  const captureReport = "artifacts/parity/capture-repair-run.json";
  const originalReport = "artifacts/parity/capture-original-run.json";
  const verification = "artifacts/migration/verify-completed-m0.json";
  const reference = {
    base_renderer_source_sha256: "a".repeat(64),
    repairs_sha256: digest([]),
    repairs: [],
  };
  const ledger = {
    reference_baseline: {
      renderer_source_sha256: reference.base_renderer_source_sha256,
      capture_report: originalReport,
    },
    reference_repairs: [],
    milestones: [
      {
        id: "M0",
        status: "done",
        tasks: [{ id: "M0-T6", status: "done", verification, effective_reference: reference }],
      },
      { id: "M1", status: "in_progress", frozen_reference: reference, tasks: [] },
      { id: "M2", status: "pending", tasks: [] },
    ],
  };
  await cp(join(f.root, "refs"), join(f.root, "artifacts/parity/reference"), { recursive: true });
  const originalSource = {
    renderer_source_sha256: reference.base_renderer_source_sha256,
    tree_sha256: "b".repeat(64),
  };
  await f.json(originalReport, {
    status: "passed",
    exit_code: 0,
    source_unchanged: true,
    source: originalSource,
    source_after: originalSource,
    run_id: "original-run",
    host: { cacheIdentity: { device: "fixture" } },
    cases: [{ id: "sequence", status: "cached" }],
  });
  await f.json(verification, {
    schema_version: 1,
    milestone: "M0",
    mode: "full",
    status: "passed",
    required_gates_passed: true,
    milestone_exit_satisfied: true,
    milestone_exit: {
      status: "passed",
      reference: {
        renderer_source_sha256: reference.base_renderer_source_sha256,
        digest: f.original.digest,
        cases: 1,
        frames: 3,
        required_frames: 1,
      },
    },
  });
  await f.json(captureReport, await f.reader().json("snapshots/capture.json"));
  await f.json("docs/migration/rust-renderer-progress.json", ledger);
  return { ...f, candidates, captureReport, reference, ledger, verification };
}

test("TS comparison audits complete capture provenance, keeps one build, and binds frozen references", async (t) => {
  for (const fault of [
    null,
    "pixel",
    "coverage",
    "source",
    "manifest",
    "build",
    "stale",
    "unverified",
    "partial",
    "unsafe-run",
    "missing-report",
    "bad-pixels",
    "frame-source",
    "repair-drift",
    "frozen-drift",
    "binding",
  ]) {
    const f = await candidateFixture(t);
    const manifest = await f.reader().json(f.candidates);
    if (fault === "stale") manifest.source.renderer_source_sha256 = "f".repeat(64);
    if (fault === "unverified") manifest.source_verified = false;
    if (fault === "partial") manifest.scope = "diagnostic";
    if (fault === "unsafe-run") manifest.run_id = "../unsafe";
    await f.json(f.candidates, manifest);
    const capture = await f.reader().json(f.captureReport);
    capture.candidate.manifest_sha256 = await f.hash(f.candidates);
    await f.json(f.captureReport, capture);
    if (fault === "missing-report") await rm(join(f.root, f.captureReport));
    if (fault === "bad-pixels") await f.write("snapshots/repair/sequence/1/frame.png", "corrupt");
    if (fault === "frame-source") {
      // Even internally rehashed metadata cannot relabel an old frame as current-source evidence.
      const path = "snapshots/repair/sequence/0/meta.json";
      const meta = await f.reader().json(path);
      meta.renderer_source_sha256 = "f".repeat(64);
      await f.json(path, meta);
      const casePath = "snapshots/repair/sequence/capture.json";
      const record = await f.reader().json(casePath);
      record.frames.find((item) => item.frame === 0).meta_sha256 = await f.hash(path);
      await f.json(casePath, record);
      manifest.cases[0].capture_sha256 = await f.hash(casePath);
      await f.json(f.candidates, manifest);
      capture.candidate.manifest_sha256 = await f.hash(f.candidates);
      await f.json(f.captureReport, capture);
    }
    if (fault === "repair-drift") f.ledger.reference_repairs.push({ case_id: "unapproved" });
    if (fault === "frozen-drift")
      f.ledger.milestones[1].frozen_reference = { ...f.reference, repairs_sha256: "f".repeat(64) };
    await f.json("docs/migration/rust-renderer-progress.json", f.ledger);
    let reads = 0;
    let compared = 0;
    let builds = 0;
    const result = await verifyTsPixels(
      { root: f.root, candidates: f.candidates, milestone: "M1" },
      {
        provenance: async () => ({ source_sha256: fault === "source" ? String(reads++) : "same" }),
        rendererSource: async () => ({ renderer_source_sha256: "d".repeat(64) }),
        execute: async (command) => {
          assert.equal(command.id, "compare-build");
          builds++;
          return {
            status: fault === "build" ? "failed" : "passed",
            exit_code: fault === "build" ? 1 : 0,
          };
        },
        runPixelGate: async (_context, options) => {
          compared++;
          assert.equal(options.scope, "full");
          assert.equal(options.profileOverride, "exact");
          if (fault === "manifest") await f.write(f.candidates, '{"changed":true}');
          return {
            id: "G3",
            status: fault === "pixel" ? "failed" : "passed",
            scope: "full",
            full_coverage: fault !== "coverage",
            required_count: 1,
            reference_binding:
              fault === "binding" ? { ...f.reference, repairs: ["unexpected"] } : f.reference,
          };
        },
      },
    );
    assert.equal(builds, 1);
    assert.equal(
      compared,
      [
        "build",
        "stale",
        "unverified",
        "partial",
        "unsafe-run",
        "missing-report",
        "bad-pixels",
        "frame-source",
        "repair-drift",
        "frozen-drift",
      ].includes(fault)
        ? 0
        : 1,
      fault,
    );
    assert.equal(result.exitCode, fault ? 1 : 0, fault);
    assert.equal(result.report.status, fault ? "failed" : "passed", fault);
    if (!fault) assert.equal(result.report.candidate_capture.captured_frames, 3);
    assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report);
  }
});

test("M2 retains exact and frozen M0 references without checking historical M0 candidate source", async (t) => {
  const f = await candidateFixture(t);
  const result = await verifyTsPixels(
    { root: f.root, candidates: f.candidates, milestone: "M2" },
    {
      provenance: async () => ({ source_sha256: "same" }),
      rendererSource: async () => ({ renderer_source_sha256: "d".repeat(64) }),
      execute: async () => ({ status: "passed", exit_code: 0 }),
      runPixelGate: async (_context, options) => {
        assert.equal(options.profileOverride, "exact");
        return {
          id: "G3",
          status: "passed",
          scope: "full",
          full_coverage: true,
          required_count: 1,
          reference_binding: f.reference,
        };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.frozen_reference, f.reference);
});

test("M1 rejects a self-consistent replacement of an original sequence neighbor", async (t) => {
  const f = await candidateFixture(t);
  const prefix = "artifacts/parity/reference/sequence/0";
  const image = await f.reader().image(`${prefix}/frame.png`);
  image.pixels[0] += 1;
  const png = encodeRgbaPng(image.width, image.height, image.pixels);
  await f.write(`${prefix}/frame.png`, png);
  const meta = await f.reader().json(`${prefix}/meta.json`);
  meta.png_sha256 = sha256(png);
  meta.rgba_sha256 = sha256(image.pixels);
  await f.json(`${prefix}/meta.json`, meta);
  const path = "artifacts/parity/reference/sequence/capture.json";
  const capture = await f.reader().json(path);
  Object.assign(
    capture.frames.find((frame) => frame.frame === 0),
    {
      png_sha256: meta.png_sha256,
      meta_sha256: await f.hash(`${prefix}/meta.json`),
    },
  );
  await f.json(path, capture);
  await assert.rejects(
    auditTsCandidate(f.reader(), f.candidates, { renderer_source_sha256: "d".repeat(64) }, "M1"),
    /Frozen original reference bytes differ/,
  );
});

test("M1 rejects internally valid candidate media inputs that differ from the frozen reference", async (t) => {
  const f = await candidateFixture(t);
  const manifest = await f.reader().json(f.candidates);
  const path = "snapshots/repair/sequence/capture.json";
  const capture = await f.reader().json(path);
  capture.inputs.assets = [{ path: "changed.wav", sha256: "f".repeat(64) }];
  const caseHash = digest(capture.inputs);
  capture.cache_key = digest({
    source: manifest.source.renderer_source_sha256,
    case: caseHash,
    adapter: manifest.host.cacheIdentity,
  });
  for (const frame of capture.frames) {
    const metaPath = `snapshots/repair/sequence/${frame.frame}/meta.json`;
    const meta = await f.reader().json(metaPath);
    meta.case_sha256 = caseHash;
    meta.cache_key = capture.cache_key;
    await f.json(metaPath, meta);
    frame.meta_sha256 = await f.hash(metaPath);
    const requested = manifest.frames.find((entry) => entry.frame === frame.frame);
    if (requested) requested.meta_sha256 = frame.meta_sha256;
  }
  await f.json(path, capture);
  manifest.cases[0].case_sha256 = caseHash;
  manifest.cases[0].capture_sha256 = await f.hash(path);
  await f.json(f.candidates, manifest);
  const report = await f.reader().json(f.captureReport);
  report.candidate.manifest_sha256 = await f.hash(f.candidates);
  await f.json(f.captureReport, report);
  await assert.rejects(
    auditTsCandidate(f.reader(), f.candidates, { renderer_source_sha256: "d".repeat(64) }, "M1"),
    /Candidate project\/media\/frame inputs differ from the frozen reference/,
  );
});

test("M1 requires passed full M0 exit verification before accepting its reference digest", async (t) => {
  for (const fault of ["missing", "failed", "quick", "incomplete"]) {
    const f = await candidateFixture(t);
    if (fault === "missing") await rm(join(f.root, f.verification));
    else {
      const report = await f.reader().json(f.verification);
      if (fault === "failed") report.status = "failed";
      if (fault === "quick") report.mode = "quick";
      if (fault === "incomplete") report.milestone_exit_satisfied = false;
      await f.json(f.verification, report);
    }
    await assert.rejects(
      auditTsCandidate(f.reader(), f.candidates, { renderer_source_sha256: "d".repeat(64) }, "M1"),
    );
  }
});

test("standalone M0 TS comparison does not require its not-yet-completed exit verification", async (t) => {
  const f = await candidateFixture(t);
  f.ledger.milestones[0].status = "in_progress";
  f.ledger.milestones[0].tasks[0].status = "in_progress";
  f.ledger.milestones[1].status = "pending";
  delete f.ledger.milestones[1].frozen_reference;
  await f.json("docs/migration/rust-renderer-progress.json", f.ledger);
  await rm(join(f.root, f.verification));
  const result = await auditTsCandidate(f.reader(), f.candidates, {
    renderer_source_sha256: "d".repeat(64),
  });
  assert.equal(result.reference, null);
  assert.equal(result.captured.requested.size, 1);
});
