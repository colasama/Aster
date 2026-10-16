import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import electron from "electron";
import { runAppChecks } from "./app-checks.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** A fresh packaged application plus real native queue lifecycle, independent of pixel acceptance. */
export async function runNativeAppGate(context, execute = runStep) {
  const started = Date.now();
  const report = { id: "G6", status: "failed", steps: [], native_export_acceptance: false };
  await mkdir(context.output, { recursive: true });
  try {
    report.source = await sourceProvenance(context.root);
    report.application = await runAppChecks(context, execute);
    assert.equal(report.application.status, "passed", report.application.error);
    const packagedDirectory = join(context.output, "package/win-unpacked");
    report.packaged_app = {
      path: relative(context.root, join(packagedDirectory, "resources/app.asar")).replaceAll(
        "\\",
        "/",
      ),
      sha256: await hashFile(join(packagedDirectory, "resources/app.asar")),
    };
    report.packaged_renderer = {
      path: relative(
        context.root,
        join(packagedDirectory, "resources/bin/aster-render-cli.exe"),
      ).replaceAll("\\", "/"),
      sha256: await hashFile(join(packagedDirectory, "resources/bin/aster-render-cli.exe")),
    };
    assert.equal(
      report.packaged_renderer.sha256,
      await hashFile(join(context.root, "target/release/aster-render-cli.exe")),
    );
    const captureDirectory = join(context.output, "capture");
    const capture = await execute(
      {
        id: "native-queue-capture",
        file: "node",
        args: ["scripts/migration/native-media-frame-capture.mjs", captureDirectory],
        env: { ASTER_NATIVE_JOB_CAPTURE: "1" },
        timeout_ms: 300000,
      },
      context,
    );
    report.steps.push(capture);
    assert.equal(capture.status, "passed");
    const capturePath = join(captureDirectory, "report.json");
    report.capture = {
      path: relative(context.root, capturePath).replaceAll("\\", "/"),
      sha256: await hashFile(capturePath),
    };
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.status, "passed");
    assert.equal(captured.source.source_sha256, report.source.source_sha256);
    const output = join(context.output, "native-queue");
    await mkdir(output);
    const config = join(context.output, "native-queue-config.json");
    await writeAtomicJson(config, {
      root: context.root,
      output,
      packagedDirectory,
      appPath: join(packagedDirectory, "resources/app.asar"),
      source: report.source,
      capture: capturePath,
      capture_sha256: await hashFile(capturePath),
    });
    const queue = await execute(
      {
        id: "native-queue",
        file: electron,
        args: ["scripts/migration/native-queue-electron.mjs"],
        env: { ASTER_NATIVE_QUEUE_CONFIG: config },
        timeout_ms: 900000,
      },
      context,
    );
    report.steps.push(queue);
    report.queue = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    report.queue_evidence = {
      path: relative(context.root, join(output, "report.json")).replaceAll("\\", "/"),
      sha256: await hashFile(join(output, "report.json")),
    };
    assert.equal(queue.status, "passed", report.queue.error);
    assert.equal(report.queue.status, "passed");
    assert.deepEqual(
      report.queue.jobs.map((job) => job.scenario),
      ["complete", "audio", "pause-export", "cancel-preflight", "cancel-export", "fallback"],
    );
    assert.equal(report.queue.runtime.binary.sha256, report.packaged_renderer.sha256);
    report.source_after = await sourceProvenance(context.root);
    report.source_unchanged = report.source_after.source_sha256 === report.source.source_sha256;
    assert.equal(
      report.source_after.source_sha256,
      report.source.source_sha256,
      "Application sources changed during verification",
    );
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  assert(values.out, "--out is required");
  const report = await runNativeAppGate({
    root: process.cwd(),
    output: resolve(values.out),
    env: process.env,
    print: console.log,
  });
  console.log(JSON.stringify({ status: report.status, error: report.error }));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
