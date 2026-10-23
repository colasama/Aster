import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import electron from "electron";
import { runPreviewAppGate } from "./preview-app-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Bind production-default packaged preview, native queue outputs and TS renderer retirement. */
export async function runProductionAppGate(context, execute = runStep, dependencies = {}) {
  const provenance = dependencies.provenance ?? sourceProvenance,
    started = Date.now(),
    { root, output } = context;
  const report = {
    id: "G6",
    kind: "production-native-application",
    status: "failed",
    execution_complete: false,
    evidence: {},
    steps: [],
  };
  const pin = async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: await hashFile(path),
  });
  try {
    report.source = await provenance(root);
    assert.equal(report.source.source_sha256, context.source.source_sha256);
    const previewOutput = join(output, "preview"),
      previewPath = join(previewOutput, "report.json");
    const preview = await (dependencies.runPreviewAppGate ?? runPreviewAppGate)(
      { ...context, output: previewOutput, productionDefaults: true },
      execute,
    );
    report.preview = preview;
    assert(["passed", "incomplete"].includes(preview.status), preview.error);
    assert.equal(preview.application.status, "passed");
    for (const name of ["editor", "interactions", "plugins", "recovery"])
      assert.equal(preview[name]?.status, "passed", name);
    assert.equal(preview.production_defaults, true);
    assert.equal(preview.source_unchanged, true);
    for (const source of [preview.source, preview.source_after])
      for (const key of ["source_sha256", "execution_sha256"])
        assert.equal(source[key], report.source[key]);
    assert.deepEqual(JSON.parse(await readFile(previewPath, "utf8")), preview);
    if (preview.status === "passed") {
      assert.equal(preview.latency?.status, "passed");
      assert.equal(
        preview.performance_evidence?.path,
        relative(root, context.previewPerformancePath).replaceAll("\\", "/"),
      );
      assert.equal(
        await hashFile(context.previewPerformancePath),
        preview.performance_evidence.sha256,
      );
      assert.deepEqual(
        JSON.parse(await readFile(context.previewPerformancePath, "utf8")),
        context.previewPerformance,
      );
    }
    report.evidence.preview = await pin(previewPath);
    const archive = join(previewOutput, "package/win-unpacked/resources/app.asar"),
      packageReport = join(output, "package.json"),
      queueOutput = join(output, "queue");
    report.packaged_app = await pin(archive);
    const renderer = preview.packaged_renderer;
    assert.equal(await hashFile(join(root, renderer.path)), renderer.sha256);
    assert.equal(
      await hashFile(join(root, "target/release/aster-render-cli.exe")),
      renderer.sha256,
    );
    for (const command of [
      {
        id: "production-package-boundary",
        file: electron,
        args: ["scripts/migration/production-package-capture.mjs", archive, packageReport],
        timeout_ms: 60000,
      },
      {
        id: "production-native-queue",
        file: "node",
        args: ["scripts/migration/native-queue-application-capture.mjs", queueOutput],
        timeout_ms: 300000,
      },
    ]) {
      const step = await execute(command, context);
      report.steps.push(step);
      assert.equal(step.status, "passed", command.id);
    }
    const packaged = JSON.parse(await readFile(packageReport, "utf8")),
      queuePath = join(queueOutput, "report.json"),
      queue = JSON.parse(await readFile(queuePath, "utf8"));
    assert.equal(packaged.status, "passed", packaged.error);
    assert.equal(resolve(packaged.archive), resolve(archive));
    assert.equal(packaged.archive_sha256, report.packaged_app.sha256);
    assert.equal(packaged.boundary.reference, false);
    assert.deepEqual(packaged.boundary.retained_modules, []);
    assert.equal(queue.status, "passed", queue.error);
    assert.deepEqual(queue.host_ipc, []);
    assert.deepEqual(queue.retired_ipc_registrations, []);
    assert.equal(queue.native_jobs_cleaned, true);
    assert.deepEqual(
      queue.outputs.map((item) => item.kind),
      ["still", "pngSequence", "mp4"],
    );
    assert.equal(queue.launches.length, 3);
    assert.equal(queue.persisted_jobs.length, 3);
    for (const item of queue.outputs) {
      assert.equal(item.result.status, "completed");
      assert.equal(queue.persisted_jobs.find((job) => job.id === item.id)?.status, "completed");
      assert.equal(queue.launches.filter((job) => job.jobId === item.id).length, 1);
    }
    assert.equal(queue.png.first_frame_exact, true);
    assert.equal(queue.png.sequence_frames, 12);
    for (const name of [
      "renderHost",
      "startMp4Export",
      "writeMp4Frame",
      "writeMp4Audio",
      "finishMp4Export",
      "cancelMp4Export",
    ])
      assert(!queue.preload_exports.includes(name), name);
    assert(
      queue.video.streams.some(
        (s) => s.codec_type === "video" && s.codec_name === "h264" && Number(s.nb_frames) === 12,
      ),
    );
    assert(queue.video.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"));
    report.evidence.package = await pin(packageReport);
    report.evidence.queue = await pin(queuePath);
    const still = queue.outputs[0].path,
      sequence = queue.outputs[1].path,
      names = (await readdir(sequence)).filter((name) => name.endsWith(".png")).sort();
    assert.equal(names.length, 12);
    assert.equal(await hashFile(still), queue.png.sha256);
    report.outputs = [];
    for (const path of [still, ...names.map((name) => join(sequence, name))]) {
      const evidence = await pin(path);
      assert.equal(evidence.sha256, queue.png.sha256);
      report.outputs.push(evidence);
    }
    report.outputs.push(await pin(queue.outputs[2].path));
    report.queue = {
      status: "passed",
      output_kinds: queue.outputs.map((item) => item.kind),
      native_jobs: 3,
      retired_ipc_calls: 0,
      clean_close: true,
    };
    for (const evidence of [
      report.packaged_app,
      renderer,
      ...report.outputs,
      ...Object.values(report.evidence),
    ])
      assert.equal(await hashFile(join(root, evidence.path)), evidence.sha256);
    report.source_after = await provenance(root);
    report.source_unchanged = report.source_after.source_sha256 === report.source.source_sha256;
    assert(report.source_unchanged);
    assert.equal(report.source_after.execution_sha256, report.source.execution_sha256);
    report.execution_complete = true;
    report.status = preview.status;
    if (preview.status !== "passed")
      report.error =
        "Production application and retirement checks passed; current preview latency evidence is still required";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
