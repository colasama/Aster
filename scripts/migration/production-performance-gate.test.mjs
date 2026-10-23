import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runProductionPerformanceGate } from "./production-performance-gate.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";
import { fixture } from "./verify-fixtures.mjs";

test("production performance requires full current export and preview suites", async (t) => {
  for (const mode of [
    "passed",
    "smoke",
    "partial",
    "slower-export",
    "failed-preview",
    "bad-latency",
    "wrong-source",
    "different-binary",
    "hardware-change",
    "disk-mismatch",
    "file-change",
  ]) {
    const context = await fixture(t),
      calls = [],
      source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) },
      hardware = { runConditions: { baselineEligible: true } };
    context.source = source;
    const nativePath = "native/aster-render-cli.exe",
      previewPath = "target/release/aster-render-cli.exe";
    await mkdir(join(context.root, "native"), { recursive: true });
    await mkdir(join(context.root, "target/release"), { recursive: true });
    await writeFile(join(context.root, nativePath), "native");
    await writeFile(
      join(context.root, previewPath),
      mode === "different-binary" ? "different" : "native",
    );
    const nativePin = { path: nativePath, sha256: await hashFile(join(context.root, nativePath)) },
      previewPin = { path: previewPath, sha256: await hashFile(join(context.root, previewPath)) };
    const run = async (name, ctx) => {
      calls.push(name);
      const part = {
        id: "G4",
        status: name === "preview" && mode === "failed-preview" ? "failed" : "passed",
        source,
        source_after: mode === "wrong-source" ? { ...source, execution_sha256: "wrong" } : source,
        source_unchanged: true,
        hardware,
        hardware_after: hardware,
        ...(name === "export"
          ? {
              kind: "paired-authored-project-exports",
              smoke: mode === "smoke",
              full_coverage: mode !== "partial",
              execution_complete: true,
              higher_native_median_fps: mode !== "slower-export",
              native_binaries: [nativePin],
            }
          : {
              native_preview_acceptance: true,
              throughput_passed: true,
              latency: { status: mode === "bad-latency" ? "failed" : "passed" },
              arms: Array(6).fill({}),
              rounds: Array(3).fill([]),
              comparisons: Array(7).fill({}),
              binaries: [previewPin],
            }),
      };
      if (mode === "hardware-change" && name === "preview") part.hardware_after = { changed: true };
      await writeAtomicJson(
        join(ctx.output, "report.json"),
        mode === "disk-mismatch" ? { ...part, status: "failed" } : part,
      );
      if (mode === "file-change" && name === "preview")
        await writeAtomicJson(join(context.output, "export/report.json"), { changed: true });
      return part;
    };
    const result = await runProductionPerformanceGate(
      context,
      () => {
        throw Error("Unexpected process");
      },
      {
        provenance: async () => source,
        runProjectPerformanceGate: (ctx) => run("export", ctx),
        runPreviewPerformanceGate: (ctx) => run("preview", ctx),
      },
    );
    assert.equal(result.status, mode === "passed" ? "passed" : "failed", mode);
    assert.equal(result.full_coverage, mode === "passed", mode);
    assert.equal(result.native_preview_acceptance, mode === "passed", mode);
    assert.deepEqual(JSON.parse(await readFile(join(context.output, "report.json"))), result);
    if (mode === "passed") assert.deepEqual(calls, ["export", "preview"]);
    if (["smoke", "partial", "slower-export"].includes(mode)) assert.deepEqual(calls, ["export"]);
  }
});
