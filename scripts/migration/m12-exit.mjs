import assert from "node:assert/strict";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditPreviewExitEvidence } from "./m11-exit.mjs";
import { auditDeliveryDocuments, auditProductionRetirement } from "./m12-delivery.mjs";
import { assertM12Tasks, bindM12Gates } from "./m12-gates.mjs";
import { auditProductionExportPerformance } from "./m12-performance.mjs";
import { auditProductionProjects } from "./m12-project.mjs";
import { ownerProject, sourceProvenance } from "./source.mjs";

/** Complete production acceptance requires one current full invocation and reviewed delivery. */
export async function auditM12Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = assertM12Tasks(ledger),
    source = await sourceProvenance(root);
  assert.equal(source.branch, "feature/rust-renderer");
  for (const key of ["source_sha256", "execution_sha256"])
    assert.equal(source[key], report.source[key]);
  const { gates, pins } = await bindM12Gates(reader, report);
  const env = (await ownerProject(process.env)).env;
  const { corpus, ...projects } = await auditProductionProjects(reader, root, {
    gates,
    ledger,
    source,
    env,
  });
  const preview = await auditPreviewExitEvidence(reader, root, {
    corpus,
    ledger,
    gate: gates.G3.preview,
    performance: gates.G4.preview,
    app: gates.G6.preview,
    performancePin: pins["G4/preview"],
  });
  const exports = await auditProductionExportPerformance(reader, root, gates.G4.export, env);
  const retirement = await auditProductionRetirement(reader, gates.G6, gates.G4.export);
  const documentation = await auditDeliveryDocuments(reader, milestone);
  const checkedFiles = await reader.stable(),
    after = await sourceProvenance(root);
  for (const key of ["source_sha256", "execution_sha256"]) assert.equal(after[key], source[key]);
  return {
    status: "passed",
    production_preview_acceptance: true,
    production_export_acceptance: true,
    projects,
    preview,
    export_performance: exports,
    retirement,
    documentation,
    gate_reports: pins,
    checked_files: checkedFiles,
  };
}
