import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { previewApplicationEnvironment } from "./preview-app-gate.mjs";
import { runProductionAppGate } from "./production-app-gate.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";
import { fixture } from "./verify-fixtures.mjs";

test("production application uses defaults while requiring native process evidence", () => {
  const env = { ASTER_NATIVE_PREVIEW: "0", ASTER_NATIVE_QUEUE: "1", KEEP: "yes" };
  assert.deepEqual(previewApplicationEnvironment({ env, productionDefaults: true }), {
    KEEP: "yes",
    ASTER_VERIFY_NATIVE_PREVIEW: "1",
  });
  assert.equal(env.ASTER_NATIVE_PREVIEW, "0");
  assert.equal(previewApplicationEnvironment({ env }).ASTER_NATIVE_PREVIEW, "1");
});

test("production application gate rejects missing, altered or partial delivery evidence", async (t) => {
  for (const mode of [
    "passed",
    "missing-latency",
    "bad-latency",
    "flags",
    "preview-failed",
    "source-change",
    "disk-mismatch",
    "wrong-binary",
    "reference-package",
    "archive-change",
    "legacy-ipc",
    "missing-output",
    "unpersisted",
    "wrong-launch",
    "unreleased",
    "wrong-codec",
    "changed-png",
  ]) {
    const context = await fixture(t),
      source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) };
    context.source = source;
    context.previewPerformancePath = join(context.output, "performance.json");
    context.previewPerformance = { latency: { status: "passed" } };
    await writeAtomicJson(context.previewPerformancePath, context.previewPerformance);
    const save = async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      return {
        path: relative(context.root, path).replaceAll("\\", "/"),
        sha256: await hashFile(path),
      };
    };
    const archive = join(context.output, "preview/package/win-unpacked/resources/app.asar");
    await save(archive, "archive");
    const renderer = await save(join(dirname(archive), "bin/aster-render-cli.exe"), "renderer");
    await save(
      join(context.root, "target/release/aster-render-cli.exe"),
      mode === "wrong-binary" ? "different" : "renderer",
    );
    const runPreviewAppGate = async (ctx) => {
      assert.equal(ctx.productionDefaults, true);
      const part = {
        id: "G6",
        status:
          mode === "missing-latency"
            ? "incomplete"
            : mode === "preview-failed"
              ? "failed"
              : "passed",
        source,
        source_after:
          mode === "source-change" ? { ...source, execution_sha256: "different" } : source,
        source_unchanged: true,
        production_defaults: mode !== "flags",
        packaged_renderer: renderer,
        application: { status: "passed" },
        editor: { status: "passed" },
        interactions: { status: "passed" },
        plugins: { status: "passed" },
        recovery: { status: "passed" },
        latency: { status: mode === "bad-latency" ? "failed" : "passed" },
        performance_evidence: {
          path: relative(context.root, context.previewPerformancePath).replaceAll("\\", "/"),
          sha256: await hashFile(context.previewPerformancePath),
        },
      };
      await writeAtomicJson(
        join(ctx.output, "report.json"),
        mode === "disk-mismatch" ? { ...part, status: "failed" } : part,
      );
      return part;
    };
    const execute = async (command) => {
      if (command.id === "production-package-boundary") {
        await writeAtomicJson(command.args[2], {
          status: "passed",
          archive,
          archive_sha256: await hashFile(archive),
          boundary: { reference: mode === "reference-package", retained_modules: [] },
        });
      } else {
        assert.equal(command.id, "production-native-queue");
        const dir = command.args[1],
          still = await save(join(dir, "still.png"), "png");
        const sequence = join(dir, "sequence");
        for (let index = 0; index < 12; index++)
          await save(
            join(sequence, `${index}.png`),
            mode === "changed-png" && index === 5 ? "changed" : "png",
          );
        await save(join(dir, "video.mp4"), "video");
        const outputs = ["still", "pngSequence", "mp4"].map((kind, index) => ({
          id: `job-${index}`,
          kind,
          path: [join(dir, "still.png"), sequence, join(dir, "video.mp4")][index],
          result: { status: "completed" },
        }));
        await writeAtomicJson(join(dir, "report.json"), {
          status: "passed",
          host_ipc: mode === "legacy-ipc" ? ["aster:render-host-frame"] : [],
          retired_ipc_registrations: [],
          preload_exports: [],
          native_jobs_cleaned: mode !== "unreleased",
          outputs: mode === "missing-output" ? outputs.slice(0, 2) : outputs,
          launches: outputs.map((o) => ({ jobId: mode === "wrong-launch" ? "wrong" : o.id })),
          persisted_jobs: outputs.map((o) => ({
            id: o.id,
            status: mode === "unpersisted" ? "running" : "completed",
          })),
          png: { first_frame_exact: true, sequence_frames: 12, sha256: still.sha256 },
          video: {
            streams: [
              {
                codec_type: "video",
                codec_name: mode === "wrong-codec" ? "vp9" : "h264",
                nb_frames: 12,
              },
              { codec_type: "audio", codec_name: "aac" },
            ],
          },
        });
        if (mode === "archive-change") await writeFile(archive, "changed");
      }
      return { id: command.id, status: "passed" };
    };
    const result = await runProductionAppGate(context, execute, {
      provenance: async () => source,
      runPreviewAppGate,
    });
    assert.equal(
      result.status,
      mode === "passed" ? "passed" : mode === "missing-latency" ? "incomplete" : "failed",
      `${mode}: ${result.error}`,
    );
    assert.equal(result.execution_complete, ["passed", "missing-latency"].includes(mode), mode);
    if (mode === "passed") assert.equal(result.outputs.length, 14);
  }
});
