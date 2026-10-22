import assert from "node:assert/strict";
import { M0Evidence } from "./m0-evidence.mjs";
import { assertM11Tasks, bindM11Gates } from "./m11-gates.mjs";
import { editorInteractionModes } from "./preview-editor-interactions.mjs";
import { pluginLifecycleStates } from "./preview-editor-plugins.mjs";
import { auditPreviewLatency } from "./preview-latency-audit.mjs";
import { aggregatePreviewRounds, comparePreviewThroughput } from "./preview-performance-gate.mjs";
import { sourceProvenance } from "./source.mjs";

export function assertM11PixelCoverage(corpus, gate, ledger) {
  const expected = corpus.cases.flatMap((item) =>
    item.frames.map((frame) => ({ case_id: item.id, frame })),
  );
  const preview = gate.corpus;
  for (const part of [gate, preview]) {
    assert.equal(part.full_coverage, true);
    assert.equal(part.native_preview_acceptance, true);
  }
  assert.deepEqual(
    preview.cases.map((c) => ({ id: c.id, frames: c.frames })),
    corpus.cases.map((c) => ({ id: c.id, frames: c.frames })),
  );
  assert.equal(preview.pixels.status, "passed");
  assert.equal(preview.pixels.full_coverage, true);
  assert.equal(preview.pixels.required_count, expected.length);
  assert.deepEqual(
    preview.pixels.frames.map((f) => ({ case_id: f.case_id, frame: f.frame })),
    expected,
  );
  const reviews = new Map(ledger.self_reviews.map((review) => [review.evidence?.report, review]));
  for (const frame of preview.pixels.frames) {
    assert.equal(frame.status, "passed");
    assert.equal(frame.step.status, "passed");
    if (frame.profile !== "exact") {
      assert.equal(frame.self_review_required, true);
      const review = reviews.get(frame.self_review?.report);
      assert.equal(review?.verdict, "accepted");
      assert.notEqual(review.residual_class, "structural");
      assert.equal(review.case_id, frame.case_id);
      assert.equal(review.frame, frame.frame);
      assert.deepEqual(review.evidence, frame.self_review);
    }
  }
  return expected.length;
}

/** Accept complete production preview evidence from one current full invocation. */
export async function auditM11Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  assertM11Tasks(ledger);
  const source = await sourceProvenance(root);
  for (const key of ["source_sha256", "execution_sha256"])
    assert.equal(source[key], report.source[key]);
  const { gates, pins, base } = await bindM11Gates(reader, report);
  const corpus = await reader.json("tests/parity/corpus.json");
  const frameCount = assertM11PixelCoverage(corpus, gates.G3, ledger);
  const preview = gates.G3.corpus;
  // The just-completed pixel gate authenticated every image and review; do not decode them again.
  const performance = gates.G4;
  assert.equal(performance.native_preview_acceptance, true);
  assert.equal(performance.throughput_passed, true);
  assert.equal(performance.arms.length, 6);
  const rounds = [];
  for (let index = 0; index < 3; index++) {
    const pair = performance.arms.slice(index * 2, index * 2 + 2);
    assert.deepEqual(
      pair.map((a) => a.engine),
      index % 2 === 0 ? ["ts", "native"] : ["native", "ts"],
    );
    for (const arm of pair) {
      assert.equal(arm.round, index + 1);
      const witness = await reader.json(arm.evidence.path, arm.evidence.sha256);
      assert.equal(witness.status, "passed");
      assert.equal(witness.engine, arm.engine);
      assert.deepEqual(witness.benchmark, arm.benchmark);
    }
    rounds.push(
      comparePreviewThroughput(
        pair.find((a) => a.engine === "ts").benchmark,
        pair.find((a) => a.engine === "native").benchmark,
      ),
    );
  }
  assert.deepEqual(rounds, performance.rounds);
  const comparisons = aggregatePreviewRounds(rounds);
  assert.deepEqual(comparisons, performance.comparisons);
  assert(comparisons.every((c) => c.faster));
  const owner = corpus.cases.find((c) => c.id === "owner-main");
  assert(owner);
  const latency = await auditPreviewLatency(root, performance.arms, owner.composition);
  assert.equal(latency.status, "passed");
  assert.deepEqual(latency, performance.latency);
  const app = gates.G6;
  assert.equal(app.application.status, "passed");
  assert.deepEqual(app.latency, latency);
  assert.equal(app.performance_evidence.path, `${base}/G4/report.json`);
  assert.equal(app.performance_evidence.sha256, pins.G4.sha256);
  assert.deepEqual(
    app.interactions.frames.map((f) => f.id),
    [
      ...editorInteractionModes,
      "moved",
      "restored",
      "drag-preview",
      "drag-committed",
      "drag-restored",
    ],
  );
  assert.deepEqual(
    app.plugins.frames.map((f) => f.id),
    pluginLifecycleStates.flatMap((state, index) =>
      (index % 2 === 0 ? ["root", "nested"] : ["nested", "root"]).map(
        (layout) => `${state}-${layout}`,
      ),
    ),
  );
  for (const part of [app.interactions, app.plugins])
    for (const frame of part.frames) {
      const comparison = await reader.json(frame.comparison.path, frame.comparison.sha256);
      assert.equal(comparison.comparison.profile.name, "exact");
      assert.equal(comparison.comparison.passed, true);
      assert.equal(
        comparison.comparison.reference_rgba_sha256,
        comparison.comparison.candidate_rgba_sha256,
      );
    }
  assert.equal(app.editor.status, "passed");
  const recovery = await reader.json(app.recovery.capture.path, app.recovery.capture.sha256);
  assert.equal(recovery.status, "passed");
  assert.equal(recovery.frames.length, 24);
  assert.equal(recovery.snapshots.length, 2);
  assert(recovery.frames.every((frame) => frame.exact));
  assert(recovery.snapshots.every((frame) => frame.exact));
  assert.equal(recovery.clean_close, true);
  assert.equal(recovery.remaining_private_sessions, 0);
  assert.equal(recovery.rounds.length, 2);
  for (const round of recovery.rounds) {
    for (const key of [
      "idle_preserved_canvas",
      "cached_without_native_render",
      "snapshot_preserved_canvas",
      "resized",
      "device_loss_recovered",
      "producer_crash_recovered",
    ])
      assert.equal(round[key], true, key);
    assert.equal(round.exact_paused_time, 0.123456789);
    assert.equal(round.exact_snapshot_time, 0.234567891);
  }
  assert.equal(recovery.renderer_restart.old_sessions_released, true);
  assert.equal(recovery.renderer_restart.reloaded, true);
  for (const mode of ["foreground", "background"]) {
    const smoke = await reader.json(app.application.evidence[mode].report);
    assert.equal(smoke.status, "passed");
    assert.equal(smoke.native_preview.status, "passed");
    assert.equal(smoke.render_job.status, "completed");
  }
  assert.deepEqual(performance.binaries.map((b) => b.path).toSorted(), [
    "target/debug/aster-desktop-bridge.exe",
    "target/release/aster-desktop-bridge.exe",
    "target/release/aster-render-cli.exe",
  ]);
  for (const binary of [
    ...performance.binaries,
    ...preview.binaries,
    ...app.recovery.binaries,
    app.packaged_renderer,
    app.plugins.bridge,
  ])
    await reader.bytes(binary.path, binary.sha256);
  assert.equal(
    app.packaged_renderer.sha256,
    performance.binaries.find((b) => b.path === "target/release/aster-render-cli.exe").sha256,
  );
  const checkedFiles = await reader.stable();
  const after = await sourceProvenance(root);
  for (const key of ["source_sha256", "execution_sha256"]) assert.equal(after[key], source[key]);
  return {
    status: "passed",
    production_preview_acceptance: true,
    gate_reports: pins,
    coverage: {
      cases: corpus.cases.length,
      frames: frameCount,
      editor_interactions: app.interactions.frames.length,
      plugin_lifecycle: app.plugins.frames.length,
    },
    performance: { comparisons, latency },
    checked_files: checkedFiles,
    production_export_acceptance: false,
  };
}
