import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runProductionPixelGate } from "./production-pixel-gate.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";
import { fixture } from "./verify-fixtures.mjs";

test("production pixels bind both complete current paths and reject stale or partial evidence", async (t) => {
  for (const mode of [
    "passed",
    "missing-corpus",
    "partial-project",
    "failed-preview",
    "unaccepted-preview",
    "wrong-corpus",
    "wrong-source",
    "source-change",
    "file-change",
    "corpus-change",
    "disk-mismatch",
  ]) {
    const context = await fixture(t),
      calls = [];
    const source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) };
    context.source = source;
    if (mode !== "missing-corpus") {
      const path = join(context.root, "G2/report.json");
      await writeAtomicJson(path, { kind: "native-project-corpus" });
      context.projectCorpus = { path: "G2/report.json", sha256: await hashFile(path) };
    }
    let reads = 0;
    const run = async (name, ctx) => {
      calls.push(name);
      const part = {
        id: "G3",
        status: mode === "failed-preview" && name === "preview" ? "failed" : "passed",
        full_coverage: !(mode === "partial-project" && name === "project"),
        source_unchanged: true,
        ...(name === "project"
          ? { project_corpus: context.projectCorpus }
          : {
              source,
              source_after: source,
              native_preview_acceptance: mode !== "unaccepted-preview",
            }),
      };
      if (mode === "wrong-corpus" && name === "project")
        part.project_corpus = { ...context.projectCorpus, sha256: "d".repeat(64) };
      if (mode === "wrong-source" && name === "preview")
        part.source_after = { ...source, execution_sha256: "e".repeat(64) };
      await writeAtomicJson(
        join(ctx.output, "report.json"),
        mode === "disk-mismatch" ? { ...part, full_coverage: false } : part,
      );
      if (mode === "file-change" && name === "preview")
        await writeAtomicJson(join(context.output, "project/report.json"), { changed: true });
      if (mode === "corpus-change" && name === "preview")
        await writeAtomicJson(join(context.root, "G2/report.json"), { changed: true });
      return part;
    };
    const result = await runProductionPixelGate(
      context,
      () => {
        throw Error("Unexpected process");
      },
      {
        provenance: async () =>
          mode === "source-change" && reads++ > 0
            ? { ...source, source_sha256: "f".repeat(64) }
            : source,
        runNativeProjectPixelGate: (ctx) => run("project", ctx),
        runSharedPreviewGate: (ctx) => run("preview", ctx),
      },
    );
    assert.equal(result.status, mode === "passed" ? "passed" : "failed", mode);
    assert.equal(result.full_coverage, mode === "passed", mode);
    assert.equal(result.native_preview_acceptance, mode === "passed", mode);
    assert.deepEqual(JSON.parse(await readFile(join(context.output, "report.json"))), result);
    if (mode === "passed") assert.deepEqual(calls, ["project", "preview"]);
    if (mode === "partial-project") assert.deepEqual(calls, ["project"]);
    if (mode === "missing-corpus") assert.deepEqual(calls, []);
  }
});
