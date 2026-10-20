import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { runIrGate } from "./ir-gate.mjs";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { auditNativeAllocations } from "./native-allocation-gate.mjs";
import { auditNativeExpressions } from "./native-expression-gate.mjs";
import { auditNativeFileInputs } from "./native-file-input-gate.mjs";
import { auditNativeInputs } from "./native-input-gate.mjs";
import { auditNativePaths } from "./native-path-gate.mjs";
import { auditNativePlanCli } from "./native-plan-cli-gate.mjs";
import { auditNativePlanDiff } from "./native-plan-diff-gate.mjs";
import { auditProjectMediaFrames } from "./native-project-media-frames-gate.mjs";
import { auditProjectMedia } from "./native-project-media-gate.mjs";
import { auditRasterRequests } from "./native-raster-request-gate.mjs";
import { auditResourceCli } from "./native-resource-cli-gate.mjs";
import { auditResourceRequests } from "./native-resource-request-gate.mjs";
import { auditRuntimeProjects } from "./native-runtime-project-gate.mjs";
import { auditNativeScalars } from "./native-scalar-gate.mjs";
import { auditNativeScenes } from "./native-scene-gate.mjs";
import { auditNativeSceneResources } from "./native-scene-resources-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Persisted-project round trips supplement the existing cross-language IR contract. */
export async function runNativeProjectGate(context, execute = runStep) {
  const started = Date.now();
  const report = { id: "G1", status: "failed", steps: [], project_inputs: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    report.source = await sourceProvenance(context.root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const corpusFile = await reader.bytes("tests/parity/corpus.json");
    const corpus = JSON.parse(corpusFile.bytes);
    assert(corpus.cases.length > 0);
    report.corpus_sha256 = corpusFile.sha256;
    const projects = new Map();
    const ownerInputs = new Map();
    for (const item of corpus.cases) {
      let path;
      if (item.project === "env:ASTER_PERF_PROJECT") {
        assert(
          context.env.ASTER_PERF_PROJECT,
          "Owner project is required for native model coverage",
        );
        path = context.env.ASTER_PERF_PROJECT;
      } else {
        assert(!item.project.startsWith("env:"), "Unknown project environment binding");
        path = isAbsolute(item.project) ? item.project : join(context.root, item.project);
      }
      if ((await stat(path)).isDirectory()) path = join(path, "project.json");
      if (item.project === "env:ASTER_PERF_PROJECT") ownerInputs.set(path, null);
      const cases = projects.get(path) ?? [];
      cases.push(item.id);
      projects.set(path, cases);
    }
    for (const [path, cases] of projects) {
      const external = ownerInputs.has(path);
      const bytes = external ? await readFile(path) : null;
      const file = external ? { bytes, sha256: sha256(bytes) } : await reader.bytes(local(path));
      if (external) ownerInputs.set(path, file.sha256);
      const project = JSON.parse(file.bytes);
      report.project_inputs.push({
        path: external ? path : local(path),
        external_owner_project: external,
        sha256: file.sha256,
        cases,
        schema_version: project.schemaVersion,
      });
    }
    const step = await execute(
      {
        id: "native-project-roundtrips",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-project",
          "editor_model::tests::typed_editor_model_roundtrips_every_corpus_project",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      context,
    );
    report.steps.push(step);
    assert.equal(step.status, "passed");
    assert.equal(step.exit_code, 0);
    assert(!step.error && !step.signal);
    const log = await reader.bytes(step.log);
    assert(
      /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log.bytes.toString("utf8")),
      "Native corpus round-trip test did not execute",
    );
    report.runtime_projects = await auditRuntimeProjects(context, report.project_inputs, execute);
    report.project_media = await auditProjectMedia(context, report.project_inputs, execute);
    report.project_media_frames = await auditProjectMediaFrames(context, execute);
    report.raster_requests = await auditRasterRequests(context, execute);
    report.resource_requests = await auditResourceRequests(context, execute);
    report.native_inputs = await auditNativeInputs(context, execute);
    report.native_file_inputs = await auditNativeFileInputs(context, execute);
    report.native_allocations = await auditNativeAllocations(context, execute);
    report.scalar_evaluation = await auditNativeScalars(context, execute);
    report.expression_evaluation = await auditNativeExpressions(
      context,
      report.project_inputs,
      execute,
    );
    report.scene_evaluation = await auditNativeScenes(context, report.project_inputs, execute);
    report.path_evaluation = await auditNativePaths(context, report.project_inputs, execute);
    report.scene_resources = await auditNativeSceneResources(
      context,
      report.project_inputs,
      execute,
    );
    report.ir = await runIrGate({ ...context, output: join(context.output, "ir") }, execute);
    assert.equal(report.ir.status, "passed", report.ir.error);
    report.plan_cli = await auditNativePlanCli(
      context,
      join(context.output, "project-frame-oracle.json"),
      join(context.root, report.ir.binary.path),
      execute,
    );
    report.plan_diff = await auditNativePlanDiff(context, report.plan_cli, execute);
    report.resource_cli = await auditResourceCli(
      context,
      join(context.output, "resource-request-oracle.json"),
      join(context.root, report.ir.binary.path),
      execute,
    );
    report.checked_files = await reader.stable();
    for (const [path, expected] of ownerInputs)
      assert.equal(
        await hashFile(path),
        expected,
        "Owner project changed during native round trips",
      );
    report.source_after = await sourceProvenance(context.root);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    report.source_unchanged = true;
    report.project_roundtrip = {
      status: "passed",
      projects: projects.size,
      corpus_cases: corpus.cases.length,
    };
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
