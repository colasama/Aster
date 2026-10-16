import assert from "node:assert/strict";
import { join } from "node:path";
import { reviewNativeQualityDiagnostic } from "./diagnostic-quality-review.mjs";
import { auditExportQuality } from "./export-quality.mjs";
import { runNativeCorpusSchedule } from "./native-corpus-schedule.mjs";
import {
  assessNativeExportCompletion,
  assessNativeQualityDiagnostic,
  nativeExportRequirements,
  recordNativeExportCoverage,
} from "./native-export-gate.mjs";

/** Revisit frozen reference bindings, authenticated exports and both arms' visual reviews. */
export async function auditM8Quality(reader, gate, report, ledger, corpus, lifecycle, output, env) {
  assert.equal(gate.status, "passed");
  assert.equal(gate.full_coverage, true);
  assert.equal(gate.native_export_acceptance, true);
  assert.equal(gate.source_unchanged, true);
  for (const source of [gate.source, gate.source_after])
    assert.equal(source.source_sha256, report.source.source_sha256);
  const declaredCorpus = await reader.json(gate.corpus.path, gate.corpus.sha256);
  assert.deepEqual(declaredCorpus, corpus);
  assert.equal(gate.diagnostics.length, 2);
  const diagnostics = [];
  for (const mode of ["root", "recursive"]) {
    const item = gate.diagnostics.find((d) => d.mode === mode);
    assert(item);
    const raw = await reader.json(item.path, item.sha256);
    assert.equal(raw.source.execution_sha256, report.source.execution_sha256);
    await auditExportQuality(reader, raw.quality, 3);
    const assessed = await reviewNativeQualityDiagnostic(
      reader.root,
      raw,
      mode,
      ledger,
      assessNativeQualityDiagnostic(raw),
    );
    assert.equal(assessed.status, "passed");
    const review = assessed.self_review;
    assert.equal(review.status, "passed");
    assert.deepEqual(item.self_review, review);
    diagnostics.push({ ...item, ...assessed, self_review: review });
  }
  const saved = await reader.json(gate.corpus_export.path, gate.corpus_export.sha256);
  assert.equal(saved.status, "passed");
  assert.equal(saved.full_coverage, true);
  assert.equal(saved.source_unchanged, true);
  assert.equal(saved.source.source_sha256, report.source.source_sha256);
  assert.deepEqual(
    saved.required,
    corpus.cases.map((c) => c.id),
  );
  assert.deepEqual(saved.selected, saved.required);
  assert.deepEqual(
    saved.cases.map((c) => c.id),
    saved.required,
  );
  assert(saved.cases.every((c) => c.status === "passed" && c.authenticated && c.checkpoint));
  const schedule = await runNativeCorpusSchedule(
    {
      root: reader.root,
      output: join(output, "corpus"),
      env,
      source: report.source,
    },
    { resume: join(reader.root, gate.corpus_export.path), auditOnly: true },
  );
  assert.equal(schedule.status, "passed", schedule.error);
  const coverage = nativeExportRequirements(corpus);
  coverage.lifecycle = lifecycle;
  for (const entry of schedule.cases)
    recordNativeExportCoverage(coverage, entry.result, entry.checkpoint);
  assert.deepEqual(coverage.corpus, gate.coverage.corpus);
  assert.deepEqual(coverage.owner, gate.coverage.owner);
  const recomputed = assessNativeExportCompletion(
    {
      ...gate,
      coverage,
      diagnostics,
    },
    schedule,
  );
  assert.equal(recomputed.status, "passed", recomputed.error);
  return { ...recomputed, corpus_cases: schedule.cases.length, diagnostics: diagnostics.length };
}
