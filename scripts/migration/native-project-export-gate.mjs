import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { captureAssignments } from "../parity/provenance.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { exportReferencePlan } from "./export-reference-samples.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { corpusExportAssignment, runNativeCorpusExport } from "./native-corpus-export.mjs";
import {
  auditExportCheckpoint,
  exportCaseFiles,
  reviewExportCase,
} from "./native-export-checkpoint.mjs";
import { runProjectExportLifecycle } from "./native-project-export-lifecycle.mjs";
import { runCorpusExports } from "./native-project-export-runs.mjs";
import { prepareNativeProjectRuntime } from "./native-project-runtime.mjs";
import { captureProjectStructuralWitness } from "./native-project-witness.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";

/** Serial, independently checkpointed cases; no failed case can hide unvisited corpus coverage. */
export async function runNativeProjectExportGate(
  context,
  { ids, resume = context.exportResume } = {},
) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  context = { ...context, env: (await ownerProject(context.env)).env };
  const local = (p) => relative(root, p).replaceAll("\\", "/");
  const report = {
    id: "G5",
    kind: "native-project-export",
    status: "failed",
    full_coverage: false,
    native_export_acceptance: false,
    cases: [],
  };
  let prepared;
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const inputs = new PixelInputs(context);
    await inputs.loadReferenceCatalog();
    const required = inputs.corpus.cases.map((item) => item.id);
    ids ??= required;
    assert(
      ids.length && new Set(ids).size === ids.length && ids.every((id) => required.includes(id)),
    );
    report.required = required;
    report.selected = ids;
    report.corpus_sha256 = await hashFile(join(root, "tests/parity/corpus.json"));
    const reader = new M0Evidence(root);
    const prior = resume ? await reader.json(local(resolve(resume))) : null;
    if (prior)
      assert.equal(
        prior.kind,
        "native-project-export",
        "Supplied-plan export evidence cannot establish native project coverage",
      );
    context = {
      ...context,
      referenceInputs: inputs,
      checkpointSources: await checkpointSource({ ...context, source: report.source }, prior),
    };
    if (context.checkpointSources.pin) report.source_compatibility = context.checkpointSources.pin;
    prepared = await prepareNativeProjectRuntime({ ...context, output: join(output, "runtime") });
    report.lifecycle = await runProjectExportLifecycle(
      { ...context, output: join(output, "lifecycle") },
      prepared,
    );
    assert.equal(report.lifecycle.status, "passed", report.lifecycle.error);
    const assignments = await captureAssignments(
      root,
      ids.map((id) => inputs.corpus.cases.find((c) => c.id === id)),
      context.env,
    );
    for (const assignment of assignments) {
      const entry = { id: assignment.case.id, status: "failed", reused: false };
      report.cases.push(entry);
      try {
        assert(!assignment.unavailable, assignment.unavailable);
        // Reuse the authenticated repair catalog; every case still rechecks all input bytes.
        const caseInputs = inputs;
        const first = await caseInputs.reference(assignment.case, assignment.case.frames[0]);
        const composition = await caseInputs.projectComposition(assignment.case, first.capture);
        const job = corpusExportAssignment(assignment, composition);
        const plan = exportReferencePlan(job, composition);
        for (const { frame, sequence } of plan) {
          await caseInputs.reference(assignment.case, frame);
          for (const neighbor of [sequence?.previous, sequence?.next])
            if (neighbor !== undefined && neighbor !== null)
              await caseInputs.reference(assignment.case, neighbor);
        }
        const binding = caseInputs.referenceBinding();
        const previous = prior?.cases.find((c) => c.id === entry.id && c.checkpoint);
        let result;
        if (previous) {
          const checkpoint = await reader.json(
            previous.checkpoint.path,
            previous.checkpoint.sha256,
          );
          assert.equal(checkpoint.kind, "native-project-export");
          result = await auditExportCheckpoint(
            { ...context, source: report.source },
            checkpoint,
            assignment,
            binding,
          );
          entry.checkpoint = previous.checkpoint;
          entry.reused = true;
        } else {
          const directory = join(output, entry.id);
          result = await runNativeCorpusExport(
            {
              ...context,
              output: directory,
              source: report.source,
              preparedProject: prepared,
              referenceInputs: caseInputs,
            },
            [entry.id],
            {
              kind: "native-project-export",
              runCorpusExports,
              captureStructuralWitness: captureProjectStructuralWitness,
            },
          );
          const path = join(directory, "report.json");
          entry.execution = { path: local(path), sha256: await hashFile(path) };
          assert.equal(result.status, "measured", result.error);
          const checkpoint = {
            schema_version: 1,
            kind: "native-project-export",
            execution_sha256: report.source.execution_sha256,
            assignment,
            reference_binding: result.reference_binding,
            report: entry.execution,
            files: await exportCaseFiles(root, directory),
          };
          await auditExportCheckpoint(
            { ...context, source: report.source },
            checkpoint,
            assignment,
            binding,
          );
          const checkpointPath = join(output, `${entry.id}.checkpoint.json`);
          await writeAtomicJson(checkpointPath, checkpoint);
          entry.checkpoint = {
            path: local(checkpointPath),
            sha256: await hashFile(checkpointPath),
          };
        }
        assert.equal(result.kind, "native-project-export");
        entry.authenticated = true;
        for (const reference of result.cases[0].references) {
          const current = await caseInputs.reference(assignment.case, reference.frame);
          assert.equal(
            current.png_sha256,
            reference.original.sha256,
            "Frozen reference pixels changed",
          );
        }
        await caseInputs.verifyStable();
        entry.result = structuredClone(result.cases[0]);
        entry.review = await reviewExportCase(root, entry.result, inputs.ledger, result, inputs);
        entry.status = entry.review.status;
        entry.result.status = entry.status;
        entry.result.review = entry.review;
      } catch (error) {
        entry.error = error.stack ?? String(error);
      }
      await writeAtomicJson(join(output, "report.json"), report);
      context.print?.(
        `${entry.id}: ${entry.status}${entry.reused ? " (authenticated checkpoint)" : ""}`,
      );
    }
    await prepared?.assertUnchanged();
    await inputs.verifyStable();
    assert.deepEqual(
      await captureAssignments(
        root,
        assignments.map((a) => a.case),
        context.env,
      ),
      assignments,
    );
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    report.source_unchanged = true;
    report.full_coverage = required.length === ids.length && report.cases.every((c) => c.result);
    report.status = report.cases.some((c) => c.status === "failed")
      ? "failed"
      : report.full_coverage && report.cases.every((c) => c.status === "passed")
        ? "passed"
        : "incomplete";
    report.native_export_acceptance =
      report.status === "passed" && report.lifecycle.status === "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
