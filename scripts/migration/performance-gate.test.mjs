import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { digest } from "../parity/provenance.mjs";
import { measurementFixture } from "../performance/measurement-fixtures.mjs";
import { freezePreviewBaseline } from "../performance/preview-baseline.mjs";
import { runPerformanceGate } from "./performance-gate.mjs";
import { sourceProvenance } from "./source.mjs";

async function fixture(t) {
  const data = await measurementFixture(t);
  await data.baselinePreview();
  const frozen = await freezePreviewBaseline(data.root, "artifacts/preview.json");
  data.ledger.milestones[0].preview_baseline_path = frozen.path;
  data.ledger.milestones[0].preview_baseline_sha256 = frozen.sha256;
  await data.write("docs/migration/rust-renderer-progress.json", data.ledger);
  // Later renderer changes must compare to the historical pinned baseline, not rewrite it.
  await writeFile(join(data.root, "src/renderer.ts"), "export const renderer = 'current';\n");
  const context = {
    root: data.root,
    output: join(data.root, "artifacts/gate"),
    env: process.env,
    source: await sourceProvenance(data.root),
  };
  return { ...data, context };
}

test("G4 executes both fresh suites and independently audits all twenty-four medians", async (t) => {
  const data = await fixture(t);
  const commands = [];
  const gate = await runPerformanceGate(data.context, async (command) => {
    commands.push(command);
    const suite = command.args[2];
    const report = await data.createReport(
      suite,
      `fresh-${suite}`,
      data.context.source.source_sha256,
    );
    await data.write(relative(data.root, command.args[4]), report);
    return { status: "passed", exit_code: 0 };
  });
  assert.equal(gate.status, "passed", gate.error);
  assert.equal(commands.length, 2);
  assert.deepEqual(
    commands.map((item) => item.args.slice(0, 4)),
    [
      ["scripts/performance-baseline.mjs", "--suite", "throughput", "--report"],
      ["scripts/performance-baseline.mjs", "--suite", "preview", "--report"],
    ],
  );
  assert.deepEqual(
    gate.suites.map((item) => item.checks.length),
    [18, 6],
  );
  assert.deepEqual(
    gate.suites.map((item) => item.audit.runs),
    [36, 12],
  );
  assert.equal(await data.hash(gate.report_path), gate.report_sha256);
});

test("G4 rejects self-consistent invented renderer sources and MP4 mutation after the first audit", async (t) => {
  for (const problem of ["renderer", "bridge", "mp4-after-audit"]) {
    const data = await fixture(t);
    let firstOutput;
    const gate = await runPerformanceGate(data.context, async (command) => {
      const suite = command.args[2];
      if (suite === "preview" && problem === "mp4-after-audit")
        await writeFile(firstOutput, Buffer.alloc(21, 0x78));
      const report = await data.createReport(
        suite,
        `fresh-${suite}`,
        data.context.source.source_sha256,
      );
      if (suite === "throughput") {
        firstOutput = report.cases.find((item) => item.benchmark.mode === "full-mp4").output
          .encoderReport.outputPath;
        if (problem !== "mp4-after-audit") {
          if (problem === "renderer")
            report.source.files = [{ path: "src/nonexistent-renderer.ts", sha256: "e".repeat(64) }];
          else report.source.bridge_sha256 = "d".repeat(64);
          report.source.renderer_source_sha256 = digest({
            files: report.source.files,
            bridge_sha256: report.source.bridge_sha256,
          });
          report.source_after = structuredClone(report.source);
        }
      }
      await data.write(relative(data.root, command.args[4]), report);
      return { status: "passed", exit_code: 0 };
    });
    assert.equal(gate.status, "failed", problem);
    assert.match(
      gate.error,
      problem === "mp4-after-audit"
        ? /MP4 bytes changed after audit/
        : /Renderer source differs from current capture/,
    );
  }
});

test("G4 cannot pass on process success alone, stale output, a regression, or a missing baseline pin", async (t) => {
  for (const problem of ["absent", "stale", "regression", "pin"]) {
    const data = await fixture(t);
    if (problem === "pin") {
      delete data.ledger.milestones[0].preview_baseline_sha256;
      await data.write("docs/migration/rust-renderer-progress.json", data.ledger);
      data.context.source = await sourceProvenance(data.root);
    }
    let calls = 0;
    const gate = await runPerformanceGate(data.context, async (command) => {
      calls++;
      if (problem !== "absent") {
        const suite = command.args[2];
        const report = await data.createReport(
          suite,
          `fresh-${suite}`,
          data.context.source.source_sha256,
        );
        if (problem === "stale") report.started_at = "2000-01-01T00:00:00Z";
        if (problem === "regression" && suite === "preview") {
          for (const entry of report.cases) {
            entry.result.elapsedMs *= 2;
            entry.result.framesPerSecond /= 2;
            for (const sample of entry.result.samples) sample.presentCompletionMs *= 2;
          }
          const { summarizePreview } = await import("../performance/preview.mjs");
          const { performanceAssignments } = await import("../performance/measurement-audit.mjs");
          report.measurements = summarizePreview(
            report.cases,
            performanceAssignments(data.data, suite),
          );
        }
        await data.write(relative(data.root, command.args[4]), report);
      }
      return { status: "passed", exit_code: 0 };
    });
    assert.equal(gate.status, "failed", problem);
    if (problem === "pin") assert.equal(calls, 0);
    if (problem === "regression") assert.equal(calls, 2);
  }
});
