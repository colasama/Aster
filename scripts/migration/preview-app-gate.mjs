import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runAppChecks } from "./app-checks.mjs";
import { auditPreviewLatency } from "./preview-latency-audit.mjs";
import { runPreviewLifecycle } from "./preview-lifecycle-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Qualify packaged startup and native ownership separately from interactive latency. */
export async function runPreviewAppGate(context, execute = runStep) {
  const report = { id: "G6", status: "failed", scope: "native-preview-editor", steps: [] };
  const started = Date.now();
  await mkdir(context.output, { recursive: true });
  try {
    report.source = await sourceProvenance(context.root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    report.application = await runAppChecks(
      {
        ...context,
        env: { ...context.env, ASTER_NATIVE_PREVIEW: "1" },
      },
      execute,
    );
    assert.equal(report.application.status, "passed", report.application.error);
    const binary = join(context.output, "package/win-unpacked/resources/bin/aster-render-cli.exe");
    report.packaged_renderer = {
      path: relative(context.root, binary).replaceAll("\\", "/"),
      sha256: await hashFile(binary),
    };
    assert.equal(
      report.packaged_renderer.sha256,
      await hashFile(join(context.root, "target/release/aster-render-cli.exe")),
    );
    for (const command of [
      {
        id: "preview-handle-crash",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "preview_handle_guard_reclaims_after_producer_crash",
          "--",
          "--ignored",
          "--test-threads=1",
        ],
        env: { ASTER_PREVIEW_GUARD_EXE: binary },
        timeout_ms: 600000,
      },
      {
        id: "preview-editor-capture",
        file: process.execPath,
        args: ["scripts/migration/preview-editor-capture.mjs", join(context.output, "editor")],
        timeout_ms: 300000,
      },
    ]) {
      const step = await execute(command, context);
      report.steps.push(step);
      assert.equal(step.status, "passed", `${command.id} failed`);
    }
    const path = join(context.output, "editor/report.json");
    const witness = JSON.parse(await readFile(path, "utf8"));
    assert.equal(witness.status, "passed", witness.error);
    assert(
      witness.native_calls.some(
        (c) => c.channel === "aster:native-preview-present" && c.time === 0.123456789,
      ),
    );
    assert(witness.native_calls.some((c) => c.ready?.source?.kind === "project"));
    assert.equal(witness.preview.frames.length, 3);
    assert.equal(witness.resize[0].width, 160);
    report.editor = {
      status: "passed",
      evidence: {
        path: relative(context.root, path).replaceAll("\\", "/"),
        sha256: await hashFile(path),
      },
      exact_time: 0.123456789,
      explicit_capture: true,
      resize: true,
    };
    report.recovery = await runPreviewLifecycle(
      {
        ...context,
        output: join(context.output, "recovery"),
      },
      execute,
    );
    assert.equal(report.recovery.status, "passed", report.recovery.error);
    report.source_after = await sourceProvenance(context.root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.status = "incomplete";
    report.error =
      "Packaged preview, queue smoke, producer-crash cleanup and renderer/device recovery passed; independent input latency acceptance remains required";
    if (context.previewPerformance?.latency?.status === "passed") {
      const performance = JSON.parse(await readFile(context.previewPerformancePath, "utf8"));
      assert.deepEqual(performance, context.previewPerformance);
      assert.equal(performance.source.source_sha256, report.source.source_sha256);
      assert.equal(performance.source_unchanged, true);
      report.latency = await auditPreviewLatency(
        context.root,
        performance.arms,
        performance.arms[0].benchmark.compositionId,
      );
      assert.equal(report.latency.status, "passed");
      report.performance_evidence = {
        path: relative(context.root, context.previewPerformancePath).replaceAll("\\", "/"),
        sha256: await hashFile(context.previewPerformancePath),
      };
      report.status = "passed";
      delete report.error;
    }
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
