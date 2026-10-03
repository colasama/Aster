import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { encodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { auditM1Exit } from "./m1-exit.mjs";
import { writeAtomicJson } from "./report.mjs";
import { staticCommands } from "./static-checks.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-m1-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = "a".repeat(64);
  const renderer = "b".repeat(64);
  const source = { source_sha256: tree };
  const rendererSource = { renderer_source_sha256: renderer, tree_sha256: tree };
  const binding = { base_renderer_source_sha256: "c".repeat(64), repairs: [] };
  const ledger = {
    milestones: [
      { id: "M0", status: "done" },
      {
        id: "M1",
        status: "in_progress",
        frozen_reference: binding,
        tasks: Array.from({ length: 6 }, (_, index) => ({
          id: `M1-T${index + 1}`,
          status: index === 5 ? "in_progress" : "done",
        })),
      },
    ],
  };
  await writeAtomicJson(join(root, "docs/migration/rust-renderer-progress.json"), ledger);
  await writeAtomicJson(join(root, "tests/parity/corpus.json"), {
    cases: [{ id: "fixture", frames: [0], size: { width: 1, height: 1 } }],
  });
  const hashedJson = async (path, value) => {
    await writeAtomicJson(join(root, path), value);
    return { path, sha256: sha256(await readFile(join(root, path))) };
  };
  const hashedFile = async (path, bytes) => {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    return { path, sha256: sha256(bytes) };
  };
  const pixels = Buffer.from([8, 16, 24, 255]);
  const pngBytes = encodeRgbaPng(1, 1, pixels);
  const candidatePng = await hashedFile("artifacts/candidate/fixture/0/frame.png", pngBytes);
  const referencePng = await hashedFile("artifacts/parity/reference/fixture/0/frame.png", pngBytes);
  const candidate = await hashedJson("artifacts/candidate.json", {
    schema_version: 1,
    frames: [
      {
        case_id: "fixture",
        frame: 0,
        path: "candidate/fixture/0/frame.png",
        png_sha256: candidatePng.sha256,
        rgba_sha256: sha256(pixels),
      },
    ],
  });
  const catalog = await hashedJson("tests/parity/tolerances.json", {
    schema_version: 1,
    profiles: { exact: { exact: true } },
  });
  const comparison = {
    schema_version: 1,
    profile: { name: "exact", catalog_sha256: catalog.sha256 },
    width: 1,
    height: 1,
    passed: true,
    self_review_required: false,
    reference_rgba_sha256: sha256(pixels),
    candidate_rgba_sha256: sha256(pixels),
    metrics: {
      exact: true,
      pixel_count: 1,
      max_abs_channel_error: 0,
      mean_abs_error: 0,
      mean_squared_error: 0,
      rgb_mean_squared_error: 0,
      pixels_above_tolerance: 0,
    },
    isolated: false,
    sequence: null,
    checks: [{ id: "exact_rgba", passed: true }],
  };
  const pixelReport = {
    schema_version: 1,
    comparison,
    context: { case_id: "fixture", isolated: false, sequence: null },
    reference: { path: join(root, referencePng.path), png_sha256: referencePng.sha256 },
    candidate: { path: join(root, candidatePng.path), png_sha256: candidatePng.sha256 },
    previous: null,
    next: null,
  };
  const comparisonFile = await hashedJson(
    "artifacts/comparison/fixture-0/report.json",
    pixelReport,
  );
  const heatmap = await hashedFile(
    "artifacts/comparison/fixture-0/heatmap.png",
    encodeRgbaPng(1, 1, Buffer.from([0, 0, 0, 255])),
  );
  const contact = await hashedFile(
    "artifacts/comparison/fixture-0/contact-sheet.png",
    encodeRgbaPng(2, 2, Buffer.concat([pixels, pixels, pixels, pixels])),
  );
  const evidence = {
    report: comparisonFile.path,
    report_sha256: comparisonFile.sha256,
    heatmap: heatmap.path,
    heatmap_sha256: heatmap.sha256,
    contact_sheet: contact.path,
    contact_sheet_sha256: contact.sha256,
  };
  const gate = {
    id: "G3",
    status: "passed",
    scope: "full",
    full_coverage: true,
    inputs_unchanged: true,
    required_count: 1,
    comparisons: [{ case_id: "fixture", frame: 0, comparison, evidence }],
    evidence: [evidence],
    reference_binding: binding,
    frames: [
      {
        case_id: "fixture",
        frame: 0,
        profile: "exact",
        status: "passed",
        self_review_required: false,
        step: { status: "passed", exit_code: 0, signal: null },
        evidence,
      },
    ],
  };
  const exact = {
    status: "passed",
    source_unchanged: true,
    source,
    source_after: source,
    renderer_source: rendererSource,
    renderer_source_after: rendererSource,
    started_at: "2026-10-04T00:00:01Z",
    build: { status: "passed", exit_code: 0 },
    gate,
    frozen_reference: binding,
    candidate_manifest: candidate,
  };
  const exactPath = "artifacts/exact.json";
  await hashedJson(exactPath, exact);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/shared.ts"), "export const name = 'shared';\n");
  await mkdir(join(root, "shaders"));
  await writeFile(join(root, "shaders/fixture.wgsl"), "struct Value { x: f32, }\n");
  const manifest = await hashedJson("shaders/manifest.json", { fixture: "shader manifest" });
  const shared = {
    status: "passed",
    inline_wgsl_count: 0,
    coverage: { disk_matches_manifest: true, all_fragments_referenced: true },
    source_files: [
      { path: "src/shared.ts", sha256: sha256(await readFile(join(root, "src/shared.ts"))) },
    ],
    shader_files: [
      {
        path: "shaders/fixture.wgsl",
        sha256: sha256(await readFile(join(root, "shaders/fixture.wgsl"))),
      },
    ],
    manifest,
  };
  const smoke = {
    kind: "native-effect-shader-smoke",
    status: "passed",
    source_sha256: tree,
    started_at: "2026-10-04T00:00:02Z",
    manifest: await hashedJson("artifacts/effects.json", { fixture: "compiled effects" }),
  };
  const smokeFile = await hashedJson("artifacts/smoke.json", smoke);
  const report = {
    milestone: "M1",
    mode: "full",
    required_gates: ["G0", "G3"],
    source,
    started_at: "2026-10-04T00:00:00Z",
    gates: [
      {
        id: "G0",
        status: "passed",
        steps: staticCommands().map(({ id }) => ({ id, status: "passed", exit_code: 0 })),
      },
      { ...gate, source_unchanged: true, ts_verification: exactPath },
    ],
    native_effect_shots: {
      status: "passed",
      report_path: smokeFile.path,
      report_sha256: smokeFile.sha256,
    },
  };
  return {
    root,
    ledger,
    report,
    exact,
    smoke,
    shared,
    hashedJson,
    pixelReport,
    evidence,
    candidatePng,
    referencePng,
    check: (afterPixels = async () => {}) =>
      auditM1Exit(root, report, {
        auditSharedShaderSources: async () => {
          await afterPixels();
          return shared;
        },
        auditEffectShotFiles: async () => ({ status: "passed", images: 1 }),
      }),
    saveExact: () => writeAtomicJson(join(root, exactPath), exact),
  };
}

test("M1 completion binds source coverage, current full gates and fresh native shader evidence", async (t) => {
  const data = await fixture(t);
  const result = await data.check();
  assert.equal(result.status, "passed");
  assert.equal(result.exact.required_frames, 1);
  assert.equal(result.naga.source, data.report.source.source_sha256);
  assert.equal(result.native_effect_shots.report_path, "artifacts/smoke.json");
});

test("quick runs, incomplete prerequisites and skipped G0 steps cannot establish M1 exit", async (t) => {
  for (const failure of ["quick", "prerequisite", "step", "inline", "coverage"]) {
    const data = await fixture(t);
    if (failure === "quick") data.report.mode = "quick";
    if (failure === "prerequisite") {
      data.ledger.milestones[1].tasks[0].status = "pending";
      await writeAtomicJson(
        join(data.root, "docs/migration/rust-renderer-progress.json"),
        data.ledger,
      );
    }
    if (failure === "step") data.report.gates[0].steps[0].status = "skipped";
    if (failure === "inline") data.shared.inline_wgsl_count = 1;
    if (failure === "coverage") data.shared.coverage.disk_matches_manifest = false;
    await assert.rejects(data.check(), undefined, failure);
  }
});

test("stale, non-exact, incomplete or differently sourced pixel reports cannot authorize exit", async (t) => {
  for (const failure of ["stale", "profile", "coverage", "source", "reference", "duplicate"]) {
    const data = await fixture(t);
    if (failure === "stale") data.exact.started_at = "2026-10-03T00:00:00Z";
    if (failure === "profile") data.exact.gate.frames[0].profile = "gpu";
    if (failure === "coverage") data.exact.gate.full_coverage = false;
    if (failure === "source") data.exact.source = { source_sha256: "d".repeat(64) };
    if (failure === "reference") data.exact.frozen_reference = {};
    if (failure === "duplicate") data.exact.gate.frames.push(data.exact.gate.frames[0]);
    await data.saveExact();
    await assert.rejects(data.check(), undefined, failure);
  }
});

test("changed shader/candidate bytes or missing and stale native evidence fail closed", async (t) => {
  for (const failure of [
    "shader",
    "candidate",
    "native-missing",
    "native-source",
    "native-stale",
  ]) {
    const data = await fixture(t);
    if (failure === "shader") await writeFile(join(data.root, "shaders/fixture.wgsl"), "changed");
    if (failure === "candidate")
      await writeFile(join(data.root, "artifacts/candidate.json"), "changed");
    if (failure === "native-missing") delete data.report.native_effect_shots;
    if (failure.startsWith("native-") && failure !== "native-missing") {
      if (failure === "native-source") data.smoke.source_sha256 = "d".repeat(64);
      if (failure === "native-stale") data.smoke.started_at = "2026-10-03T00:00:00Z";
      const file = await data.hashedJson("artifacts/smoke.json", data.smoke);
      data.report.native_effect_shots.report_sha256 = file.sha256;
    }
    await assert.rejects(data.check(), undefined, failure);
  }
});

test("pixel artifacts and compared PNGs must still match the completed G3 hashes", async (t) => {
  for (const artifact of ["report", "heatmap", "contact_sheet", "candidate", "reference"]) {
    for (const change of ["deleted", "changed"]) {
      const data = await fixture(t);
      const path =
        artifact === "candidate"
          ? data.candidatePng.path
          : artifact === "reference"
            ? data.referencePng.path
            : data.evidence[artifact];
      if (change === "deleted") await rm(join(data.root, path));
      else await writeFile(join(data.root, path), "changed after G3");
      await assert.rejects(data.check(), undefined, `${artifact}: ${change}`);
    }
  }
});

test("comparison coverage and exact checks cannot be replaced by passed labels", async (t) => {
  for (const failure of [
    "missing",
    "duplicate",
    "wrong-key",
    "step",
    "rgba",
    "metrics",
    "checks",
  ]) {
    const data = await fixture(t);
    const gate = data.exact.gate;
    if (failure === "missing") gate.comparisons.length = 0;
    if (failure === "duplicate") gate.comparisons.push(gate.comparisons[0]);
    if (failure === "wrong-key") gate.comparisons[0].case_id = "other";
    if (failure === "step") gate.frames[0].step.exit_code = 1;
    if (failure === "rgba") data.pixelReport.comparison.candidate_rgba_sha256 = "d".repeat(64);
    if (failure === "metrics") data.pixelReport.comparison.metrics.exact = false;
    if (failure === "checks") data.pixelReport.comparison.checks = [];
    const file = await data.hashedJson(data.evidence.report, data.pixelReport);
    data.evidence.report_sha256 = file.sha256;
    await data.saveExact();
    await assert.rejects(data.check(), undefined, failure);
  }
});

test("pixel evidence remains protected until the final exit stability check", async (t) => {
  const data = await fixture(t);
  await assert.rejects(
    data.check(async () => {
      await writeFile(join(data.root, data.candidatePng.path), "changed during exit audit");
    }),
    /Evidence changed during audit/,
  );
});
