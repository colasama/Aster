import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runNativeProjectPixelGate } from "./native-project-pixel-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { runSharedPreviewGate } from "./shared-preview-gate.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Final production pixels require both authored-project execution and desktop preview. */
export async function runProductionPixelGate(context, execute = runStep, dependencies = {}) {
  const provenance = dependencies.provenance ?? sourceProvenance;
  const report = {
    id: "G3",
    kind: "production-project-and-preview-pixels",
    status: "failed",
    full_coverage: false,
    native_preview_acceptance: false,
    evidence: {},
  };
  const started = Date.now();
  try {
    assert(context.projectCorpus, "Current native project corpus evidence is required");
    report.source = await provenance(context.root);
    assert.equal(report.source.source_sha256, context.source.source_sha256);
    report.project_corpus = context.projectCorpus;
    const corpusPath = join(context.root, context.projectCorpus.path);
    assert.equal(await hashFile(corpusPath), context.projectCorpus.sha256);
    const parts = [
      ["project", dependencies.runNativeProjectPixelGate ?? runNativeProjectPixelGate],
      ["preview", dependencies.runSharedPreviewGate ?? runSharedPreviewGate],
    ];
    for (const [name, run] of parts) {
      const output = join(context.output, name),
        path = join(output, "report.json");
      const part = await run({ ...context, output }, execute);
      report[name] = part;
      assert.equal(part.id, "G3");
      assert.equal(part.status, "passed", part.error ?? `${name} pixels failed`);
      assert.equal(part.full_coverage, true, `${name} pixel coverage is incomplete`);
      assert.equal(part.source_unchanged, true, `${name} inputs changed`);
      if (name === "project") assert.deepEqual(part.project_corpus, context.projectCorpus);
      else {
        assert.equal(part.native_preview_acceptance, true);
        for (const source of [part.source, part.source_after])
          for (const key of ["source_sha256", "execution_sha256"])
            assert.equal(source[key], report.source[key]);
      }
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), part);
      report.evidence[name] = {
        path: relative(context.root, path).replaceAll("\\", "/"),
        sha256: await hashFile(path),
      };
    }
    for (const pin of Object.values(report.evidence))
      assert.equal(await hashFile(join(context.root, pin.path)), pin.sha256);
    assert.equal(await hashFile(corpusPath), context.projectCorpus.sha256);
    report.source_after = await provenance(context.root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged, "Source changed during production pixel validation");
    report.full_coverage = true;
    report.native_preview_acceptance = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
