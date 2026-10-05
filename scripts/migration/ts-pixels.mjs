import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { captureSource } from "../parity/provenance.mjs";
import { auditEncodedTextures } from "./encoded-texture-gate.mjs";
import { auditGenerators } from "./generator-gate.mjs";
import { auditLutDraws } from "./lut-draw-gate.mjs";
import { evidencePath, M0Evidence } from "./m0-evidence.mjs";
import { auditMaterialDraws } from "./material-draw-gate.mjs";
import { runStep } from "./process.mjs";
import { auditCapturedRasters } from "./raster-capture-gate.mjs";
import { writeAtomicJson } from "./report.mjs";
import { auditRootScenes } from "./root-scene-gate.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";
import { auditTemporalText } from "./temporal-text-gate.mjs";
import { auditTsCandidate } from "./ts-candidate.mjs";

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
    const reader = new M0Evidence(root);
    report.source = await provenance(root);
    assert.equal(typeof options.candidates, "string", "A fresh TS candidate manifest is required");
    const manifestPath = evidencePath(
      relative(root, resolve(root, options.candidates)).replaceAll("\\", "/"),
    );
    const manifestFile = await reader.bytes(manifestPath);
    report.candidate_manifest = {
      path: manifestPath,
      sha256: manifestFile.sha256,
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
    assert.equal(report.build.exit_code, 0, "Comparison CLI build exited unsuccessfully");
    report.renderer_source = await rendererSource(root);
    const candidate = await auditTsCandidate(
      reader,
      manifestPath,
      report.renderer_source,
      options.milestone,
    );
    report.candidate_capture = {
      report: candidate.captureReportPath,
      run_id: candidate.captured.manifest.run_id,
      required_frames: candidate.captured.requested.size,
      captured_frames: candidate.captured.frames.size,
    };
    if (candidate.reference) report.frozen_reference = candidate.reference;
    if (options.milestone === "M2")
      report.raster_resources = await (dependencies.auditCapturedRasters ?? auditCapturedRasters)(
        reader,
        manifestPath,
        context,
        execute,
      );
    if (options.milestone === "M2") {
      report.temporal_text = await (dependencies.auditTemporalText ?? auditTemporalText)(
        reader,
        context,
        execute,
      );
      assert.equal(
        report.temporal_text.status,
        "passed",
        "Temporal text GPU verification did not pass",
      );
      report.encoded_textures = await (dependencies.auditEncodedTextures ?? auditEncodedTextures)(
        reader,
        context,
        execute,
      );
      assert.equal(
        report.encoded_textures.status,
        "passed",
        "Encoded texture GPU verification did not pass",
      );
      report.material_draws = await (dependencies.auditMaterialDraws ?? auditMaterialDraws)(
        reader,
        context,
        execute,
      );
      assert.equal(
        report.material_draws.status,
        "passed",
        "Material draw GPU verification did not pass",
      );
      report.lut_draws = await (dependencies.auditLutDraws ?? auditLutDraws)(
        reader,
        context,
        execute,
      );
      assert.equal(report.lut_draws.status, "passed", "Supplied LUT draw replay failed");
      report.root_scenes = await (dependencies.auditRootScenes ?? auditRootScenes)(
        reader,
        context,
        execute,
      );
      assert.equal(report.root_scenes.status, "passed", "Root scene GPU replay failed");
      report.generators = await (dependencies.auditGenerators ?? auditGenerators)(
        reader,
        context,
        execute,
      );
      assert.equal(report.generators.status, "passed", "Generator GPU replay failed");
    }
    report.gate = await (dependencies.runPixelGate ?? runPixelGate)(
      { ...context, output: join(output, "G3") },
      { manifestPath: resolve(root, options.candidates), scope: "full", profileOverride: "exact" },
      execute,
    );
    assert.equal(report.gate.id, "G3");
    assert.equal(report.gate.scope, "full");
    assert.equal(report.gate.required_count, candidate.captured.requested.size);
    if (candidate.reference)
      assert.deepEqual(
        report.gate.reference_binding,
        candidate.reference,
        "Pixel comparison used a different pre-change reference set",
      );
    report.checked_candidate_files = await reader.stable();
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
