import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTsPixelArguments, verifyTsPixels } from "./ts-pixels.mjs";

test("TS checks cannot select a partial scope or relaxed tolerance", () => {
  assert.deepEqual(parseTsPixelArguments(["--candidates", "manifest.json"]), {
    candidates: "manifest.json",
  });
  for (const args of [
    [],
    ["--candidates"],
    ["--candidates", "--exact"],
    ["--case", "one"],
    ["--candidates", "manifest.json", "--tolerance", "gpu"],
  ]) {
    assert.throws(() => parseTsPixelArguments(args));
  }
});

test("TS comparison preserves failure, provenance and full exact coverage in atomic reports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-ts-pixels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidates = join(root, "manifest.json");
  for (const fault of [
    null,
    "pixel",
    "coverage",
    "source",
    "manifest",
    "build",
    "stale",
    "unverified",
    "partial",
  ]) {
    await writeFile(
      candidates,
      JSON.stringify({
        kind: "ts-candidate",
        source_verified: fault !== "unverified",
        scope: fault === "partial" ? "diagnostic" : "full",
        source: { renderer_source_sha256: fault === "stale" ? "old" : "same", tree_sha256: "same" },
        source_after: { renderer_source_sha256: "same", tree_sha256: "same" },
      }),
    );
    let reads = 0;
    let compared = false;
    const result = await verifyTsPixels(
      { root, candidates },
      {
        provenance: async () => ({ source_sha256: fault === "source" ? String(reads++) : "same" }),
        rendererSource: async () => ({ renderer_source_sha256: "same" }),
        execute: async () => ({ status: fault === "build" ? "failed" : "passed" }),
        runPixelGate: async (_context, options) => {
          compared = true;
          assert.equal(options.scope, "full");
          assert.equal(options.profileOverride, "exact");
          if (fault === "manifest") await writeFile(candidates, '{"changed":true}');
          return {
            status: fault === "pixel" ? "failed" : "passed",
            full_coverage: fault !== "coverage",
          };
        },
      },
    );
    assert.equal(compared, !["build", "stale", "unverified", "partial"].includes(fault));
    assert.equal(result.exitCode, fault ? 1 : 0);
    assert.equal(result.report.status, fault ? "failed" : "passed");
    assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report);
  }
});
