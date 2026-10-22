import assert from "node:assert/strict";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditM10Coverage } from "./m10-coverage.mjs";
import { assertM10Tasks, bindM10Gates } from "./m10-gates.mjs";
import { auditM10Native } from "./m10-pixels.mjs";
import { ownerProject, sourceProvenance } from "./source.mjs";

/** No replayed status can substitute for current full gates, layout, routing and pixel evidence. */
export async function auditM10Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const task = assertM10Tasks(ledger);
  const source = await sourceProvenance(root);
  assert.equal(source.source_sha256, report.source.source_sha256);
  assert.equal(source.execution_sha256, report.source.execution_sha256);
  const { gate, pins } = await bindM10Gates(reader, report);
  const corpus = await reader.bytes("tests/parity/corpus.json");
  const layout = gate.native_text_layout;
  assert.equal(layout.corpus_sha256, corpus.sha256);
  const coverage = await auditM10Coverage(
    root,
    reader,
    JSON.parse(corpus.bytes),
    layout,
    task.retained_capability_tasks,
    (await ownerProject(process.env)).env,
  );
  const native = await auditM10Native(
    reader,
    layout.native_admitted_layout,
    layout.native_project_session,
    ledger,
    layout.native_text_routing,
  );
  const embedded = await auditM10Native(
    reader,
    gate.native_text_embedded.preparation,
    gate.native_text_embedded.session,
    ledger,
  );
  const retainedFixtures = [];
  for (const group of [
    gate.native_text_fonts,
    gate.native_text_capabilities,
    gate.native_text_blur,
    { routing: gate.native_text_embedded.unqualified },
  ]) {
    for (const entry of group.routing.cases) {
      for (const reason of Object.keys(entry.reasons)) {
        assert(
          task.retained_capability_tasks.some(
            (t) =>
              t.status === "verified_retained" &&
              t.route === "M5" &&
              t.cases.includes(entry.id) &&
              t.reasons.includes(reason),
          ),
          `Unrecorded fixture capability: ${entry.id}: ${reason}`,
        );
      }
      retainedFixtures.push({
        id: entry.id,
        retained: entry.retained,
        exact_pixels: entry.exact_pixels,
        temporal_samples: entry.temporal_samples,
        reasons: entry.reasons,
      });
    }
  }
  const checkedFiles = await reader.stable();
  const after = await sourceProvenance(root);
  assert.equal(after.source_sha256, source.source_sha256);
  assert.equal(after.execution_sha256, source.execution_sha256);
  return {
    status: "passed",
    native_text_acceptance: true,
    coverage,
    native,
    embedded,
    retained_fixtures: retainedFixtures,
    gate_reports: pins,
    retained_capability_tasks: task.retained_capability_tasks.map((t) => t.id),
    checked_files: checkedFiles,
    production_preview_acceptance: false,
  };
}
