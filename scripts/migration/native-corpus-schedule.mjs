import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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
import { prepareNativeObservationRuntime } from "./native-observation-runtime.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";

export function validateReadOnlySchedule(prior, ids) {
  assert(
    prior && prior.status === "passed" && prior.full_coverage,
    "Read-only audit requires a complete accepted schedule",
  );
  assert.deepEqual(
    prior.cases.map((c) => c.id),
    ids,
  );
  assert(
    prior.cases.every(
      (c) => c.authenticated && c.status === "passed" && c.checkpoint?.path && c.checkpoint?.sha256,
    ),
  );
}

/** Serial, independently checkpointed cases; no failed case can hide unvisited corpus coverage. */
export async function runNativeCorpusSchedule(context, { ids, resume, auditOnly = false } = {}) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  context = { ...context, env: (await ownerProject(context.env)).env };
  const local = (p) => relative(root, p).replaceAll("\\", "/");
  const report = {
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
    const checkpointSources = await checkpointSource({ ...context, source: report.source }, prior);
    if (checkpointSources.pin) report.source_compatibility = checkpointSources.pin;
    if (auditOnly) validateReadOnlySchedule(prior, ids);
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
          result = await auditExportCheckpoint(
            { ...context, source: report.source, checkpointSources },
            checkpoint,
            assignment,
            binding,
          );
          entry.checkpoint = previous.checkpoint;
          entry.reused = true;
        } else {
          assert(!auditOnly, "Read-only corpus audit cannot execute a missing checkpoint");
          prepared ??= await prepareNativeObservationRuntime({
            ...context,
            output: join(output, "runtime-build"),
          });
          const directory = join(output, entry.id);
          result = await runNativeCorpusExport(
            {
              ...context,
              output: directory,
              source: report.source,
              preparedNative: prepared,
              referenceInputs: caseInputs,
            },
            [entry.id],
          );
          const path = join(directory, "report.json");
          entry.execution = { path: local(path), sha256: await hashFile(path) };
          assert.equal(result.status, "measured", result.error);
          const checkpoint = {
            schema_version: 1,
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
        entry.review = await reviewExportCase(root, entry.result, inputs.ledger, result);
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
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      case: { type: "string", multiple: true },
      resume: { type: "string" },
    },
  });
  assert(values.out);
  const report = await runNativeCorpusSchedule(
    { root: process.cwd(), output: resolve(values.out), env: process.env, print: console.log },
    { ids: values.case, resume: values.resume },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      full_coverage: report.full_coverage,
      error: report.error,
    }),
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}
