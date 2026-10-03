import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { captureSource } from "../parity/provenance.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";

export function parseTsPixelArguments(args) {
  assert.equal(args.length, 2, "Usage: parity:check-ts --candidates <manifest.json>");
  assert.equal(args[0], "--candidates", "A separate candidate manifest is required");
  assert(args[1] && !args[1].startsWith("--"), "Candidate manifest path is missing");
  return { candidates: args[1] };
}

export async function verifyTsPixels(options, dependencies = {}) {
  const { root } = options;
  const started = new Date();
  const id = `${started.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = join(root, "artifacts", "parity", "ts-check", id);
  const reportPath = join(output, "report.json");
  const report = {
    schema_version: 1,
    id,
    status: "failed",
    started_at: started.toISOString(),
  };
  const execute = dependencies.execute ?? runStep;
  const provenance = dependencies.provenance ?? sourceProvenance;
  const rendererSource = dependencies.rendererSource ?? captureSource;
  try {
    await mkdir(output, { recursive: true });
    const owner = await ownerProject(options.env ?? process.env);
    const context = { root, output, env: owner.env, print: options.print };
    report.source = await provenance(root);
    report.candidate_manifest = {
      path: relative(root, resolve(root, options.candidates)).replaceAll("\\", "/"),
      sha256: await hashFile(resolve(root, options.candidates)),
    };
    report.build = await execute(
      {
        id: "compare-build",
        file: "cargo",
        args: ["build", "--release", "-p", "aster-render-cli"],
      },
      context,
    );
    assert.equal(report.build.status, "passed", "Comparison CLI build failed");
    report.renderer_source = await rendererSource(root);
    const manifest = JSON.parse(await readFile(resolve(root, options.candidates), "utf8"));
    assert.equal(manifest.kind, "ts-candidate", "TS parity requires a production capture manifest");
    assert.equal(manifest.source_verified, true, "Candidate capture source is not verified");
    assert.equal(manifest.scope, "full", "TS parity requires a complete corpus capture");
    assert.equal(
      manifest.source?.renderer_source_sha256,
      report.renderer_source.renderer_source_sha256,
      "Candidate was captured from a different renderer source",
    );
    assert.equal(
      manifest.source?.tree_sha256,
      manifest.source_after?.tree_sha256,
      "Candidate capture changed source while rendering",
    );
    assert.equal(
      manifest.source_after?.renderer_source_sha256,
      report.renderer_source.renderer_source_sha256,
      "Candidate capture changed renderer source while rendering",
    );
    report.gate = await (dependencies.runPixelGate ?? runPixelGate)(
      { ...context, output: join(output, "G3") },
      { manifestPath: resolve(root, options.candidates), scope: "full", profileOverride: "exact" },
      execute,
    );
    report.renderer_source_after = await rendererSource(root);
    report.source_after = await provenance(root);
    report.source_unchanged =
      report.source.source_sha256 === report.source_after.source_sha256 &&
      report.renderer_source.renderer_source_sha256 ===
        report.renderer_source_after.renderer_source_sha256 &&
      report.candidate_manifest.sha256 === (await hashFile(resolve(root, options.candidates)));
    assert(report.source_unchanged, "Source or candidate manifest changed during comparison");
    assert.equal(report.gate.status, "passed", "Whole-corpus exact TS comparison did not pass");
    assert.equal(report.gate.full_coverage, true, "Diagnostic comparisons cannot prove TS parity");
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started.getTime();
  await writeAtomicJson(reportPath, report);
  options.print?.(`TS exact parity: ${report.status}\nReport: ${relative(root, reportPath)}`);
  return { report, reportPath, exitCode: report.status === "passed" ? 0 : 1 };
}
