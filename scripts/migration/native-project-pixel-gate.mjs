import assert from "node:assert/strict";
import { join } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { sourceProvenance } from "./source.mjs";

/** Only an authenticated native authored-project run can supply the pixel candidates. */
export async function runNativeProjectPixelGate(context, execute = runStep) {
  let report = { id: "G3", status: "failed", full_coverage: false };
  try {
    const reader = new M0Evidence(context.root);
    const binding = context.projectCorpus;
    assert(binding, "Native project corpus evidence is required");
    const corpus = await reader.json(binding.path, binding.sha256);
    assert.equal(corpus.kind, "native-project-corpus");
    assert.equal(corpus.status, "passed");
    assert.equal(corpus.full_coverage, true);
    assert.equal(corpus.source_unchanged, true);
    assert.equal(corpus.source.source_sha256, (await sourceProvenance(context.root)).source_sha256);
    const manifest = await reader.json(corpus.candidates.path, corpus.candidates.sha256);
    assert.equal(manifest.kind, "native-project-candidate");
    for (const file of corpus.binaries) await reader.bytes(file.path, file.sha256);
    report = {
      ...(await runPixelGate(
        context,
        { manifestPath: join(context.root, corpus.candidates.path) },
        execute,
      )),
      project_corpus: binding,
    };
    await reader.stable();
    assert.equal(corpus.source.source_sha256, (await sourceProvenance(context.root)).source_sha256);
    report.source_unchanged = true;
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
