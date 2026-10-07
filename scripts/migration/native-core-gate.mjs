import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runNativeAuxiliaryPrimaryGate } from "./native-auxiliary-primary-gate.mjs";
import {
  coreAdditionalGeometryCases,
  coreCases,
  coreCorpus,
  coreImageCases,
  coreLayerCases,
  coreSurfaceCases,
} from "./native-core-scope.mjs";

export {
  coreGeometryCases,
  coreImageCases,
  coreLayerCases,
  coreSurfaceCases,
} from "./native-core-scope.mjs";

import { runNativeRejections } from "./native-core-rejections.mjs";
import { runNativeEffectBatch } from "./native-effect-batch.mjs";
import { nativeEffectCases } from "./native-effect-scope.mjs";
import { runNativeExrGate } from "./native-exr-gate.mjs";
import { runNativeLayerCacheGate } from "./native-layer-cache-gate.mjs";
import { runNativeStillGate } from "./native-still-gate.mjs";
import { runNativeSurfaceFrameGate } from "./native-surface-frame-gate.mjs";
import { runNativeSurfacePostGate } from "./native-surface-post-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export function validateNativeReceipt(receipt, expected) {
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.native_gpu_execution, true);
  assert.equal(receipt.diagnostic_readback, true);
  assert.equal(receipt.plan_sha256, expected.plan_sha256);
  assert.equal(receipt.rgba_sha256, expected.rgba_sha256);
  assert.equal(receipt.width, expected.width);
  assert.equal(receipt.height, expected.height);
  assert.equal(receipt.adapter.name, expected.adapter.name);
  assert.equal(receipt.adapter.vendor, expected.adapter.vendorId);
  assert.equal(receipt.adapter.device, expected.adapter.deviceId);
  assert.notEqual(receipt.adapter.device_type, "Cpu");
  assert(["Dx12", "Metal", "Vulkan"].includes(receipt.adapter.backend));
}

/** Native incremental acceptance is distinct from the complete M3 core exit. */
export async function runNativeCoreGate(context, execute = runStep) {
  const started = Date.now();
  const effects = context.milestone === "M4";
  const extraCases = effects ? nativeEffectCases : [];
  const report = {
    id: "G3",
    status: "failed",
    scope: effects ? "native-effects-fused-v4" : "native-core-v5",
    native_image_decode: true,
    full_coverage: false,
    milestone_exit_eligible: false,
    native_gpu_execution: true,
    cases: [],
    frames: [],
  };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const milestone = ledger.milestones.find((item) => item.id === "M3");
    assert.equal(ledger.milestones.find((item) => item.id === "M2").status, "done");
    const manifest = await reader.json(
      milestone.input_manifest.path,
      milestone.input_manifest.sha256,
    );
    const capture = await reader.json(milestone.input_capture.path, milestone.input_capture.sha256);
    assert.equal(capture.status, "passed");
    const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
    report.input_manifest = milestone.input_manifest;
    if (effects) assert.equal(milestone.status, "done");
    report.pending_tasks = ledger.milestones
      .find((item) => item.id === (effects ? "M4" : "M3"))
      .tasks.filter((task) => task.status !== "done")
      .map((task) => task.id);
    report.build = await execute(
      {
        id: "native-core-build",
        file: "cargo",
        args: ["build", "--release", "-p", "aster-desktop-bridge", "-p", "aster-render-cli"],
      },
      context,
    );
    assert.equal(report.build.status, "passed");
    const binary = join(
      context.root,
      "target",
      "release",
      `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
    );
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const base = posix.dirname(milestone.input_manifest.path);
    const candidate = { schema_version: 1, frames: [] };
    const cases = [...coreCorpus(corpus).cases.map((item) => item.id), ...extraCases];
    assert.deepEqual(cases.slice(0, coreCases.length), coreCases);
    const compiler =
      process.platform === "win32"
        ? join(context.root, "node_modules", "electron", "dist", "dxcompiler.dll")
        : null;
    if (compiler) {
      const pinned = await reader.bytes(local(compiler));
      report.dxcompiler = { path: local(compiler), sha256: pinned.sha256 };
    }
    for (const id of coreCases) {
      const item = corpus.cases.find((value) => value.id === id);
      assert(item, `Required native core case absent: ${id}`);
      const source = manifest.cases.find((value) => value.case_id === id);
      assert(source, `Captured native core case absent: ${id}`);
      const captured = await reader.json(`${base}/${source.path}`, source.capture_sha256);
      assert.deepEqual(captured.inputs.case, item);
      const cache = new Map();
      report.cases.push(id);
      for (const frame of item.frames) {
        const record = captured.frames.find((value) => value.frame === frame);
        assert(record, `Missing captured frame: ${id}/${frame}`);
        const meta = await reader.json(`${base}/${id}/${frame}/meta.json`, record.meta_sha256);
        await validateFrameArtifacts(
          async (path) => (await reader.bytes(`${base}/${id}/${path}`)).bytes,
          meta,
          item,
          manifest.source,
          cache,
        );
        const input = `${base}/${id}/${frame}/replay.fpln`;
        const plan = await reader.bytes(input);
        const output = join(context.output, "native", id, `${frame}.png`);
        const step = await execute(
          {
            id: `native-${id}-${frame}`,
            file: binary,
            args: [
              "render-plan",
              "--plan",
              input,
              "--resources",
              `${base}/${id}/frame-resources`,
              "--out",
              output,
              ...(compiler &&
              (coreLayerCases.includes(id) ||
                coreSurfaceCases.includes(id) ||
                coreAdditionalGeometryCases.includes(id))
                ? ["--dxcompiler", compiler]
                : []),
            ],
            timeout_ms: 120_000,
          },
          context,
        );
        assert.equal(step.status, "passed", `Native execution failed: ${id}/${frame}; ${step.log}`);
        const receipt = JSON.parse(
          (await readFile(join(context.root, step.log), "utf8")).trim().split(/\r?\n/).at(-1),
        );
        const pixels = await reader.image(local(output));
        validateNativeReceipt(receipt, {
          plan_sha256: plan.sha256,
          rgba_sha256: pixels.rgba_sha256,
          ...item.size,
          adapter: meta.adapter.gpuMemory.device,
        });
        assert.equal(receipt.native_image_decode, false);
        if (coreImageCases.includes(id)) {
          assert(receipt.image_cache.uploads > 0, "Native image case uploaded no texture");
          assert(receipt.image_cache.resident_bytes > 0);
        }
        if (coreSurfaceCases.includes(id)) {
          assert(
            receipt.surface_cache.allocations > 0,
            "Native surface case allocated no GPU target",
          );
          assert(receipt.surface_cache.resident_bytes > 0);
        }
        const entry = {
          case_id: id,
          frame,
          path: relative(context.output, output).replaceAll("\\", "/"),
          png_sha256: pixels.png_sha256,
        };
        candidate.frames.push(entry);
        report.frames.push({
          case_id: id,
          frame,
          step,
          receipt,
          input: { path: input, sha256: plan.sha256 },
          output: { path: local(output), sha256: pixels.png_sha256 },
        });
      }
    }
    if (effects) {
      const extra = await runNativeEffectBatch(
        context,
        {
          reader,
          binary,
          base,
          manifest,
          corpus,
          compiler,
          validateReceipt: validateNativeReceipt,
        },
        execute,
      );
      report.cases.push(...extra.cases);
      report.frames.push(...extra.frames);
      candidate.frames.push(...extra.candidate);
      report.effect_batch = extra.batch;
    }
    report.required_count = cases.reduce(
      (count, id) => count + corpus.cases.find((item) => item.id === id).frames.length,
      0,
    );
    assert.equal(report.frames.length, report.required_count);
    const candidatePath = join(context.output, "candidate.json");
    await writeAtomicJson(candidatePath, candidate);
    report.candidate_manifest = {
      path: local(candidatePath),
      sha256: await hashFile(candidatePath),
    };
    report.pixels = await runPixelGate(
      { ...context, output: join(context.output, "pixels") },
      { manifestPath: candidatePath, scope: "diagnostic", profileOverride: "gpu" },
      execute,
    );
    assert.equal(report.pixels.status, "passed", "Native pixels differ from frozen references");
    assert.equal(report.pixels.frames.length, report.required_count);
    assert.equal(report.pixels.comparisons.length, report.required_count);
    report.rejections = await runNativeRejections(context, { reader, base, binary }, execute);
    report.image_cache = await execute(
      {
        id: "native-image-cache",
        file: "cargo",
        args: ["test", "-p", "aster-renderer", "native_", "--", "--ignored"],
      },
      context,
    );
    assert.equal(report.image_cache.status, "passed");
    report.native_stills = await runNativeStillGate(
      { ...context, output: join(context.output, "native-stills") },
      { base, binary, validateReceipt: validateNativeReceipt },
      execute,
    );
    assert.equal(report.native_stills.status, "passed", "Native still decode gate failed");
    report.native_exr = await runNativeExrGate(
      { ...context, output: join(context.output, "native-exr") },
      { base, binary, validateReceipt: validateNativeReceipt },
      execute,
    );
    assert.equal(report.native_exr.status, "passed", "Native EXR execution failed");
    if (effects) {
      report.native_surface_post = await runNativeSurfacePostGate(
        { ...context, output: join(context.output, "native-surface-post") },
        binary,
        execute,
      );
      assert.equal(report.native_surface_post.status, "passed", "Native surface post gate failed");
      report.native_auxiliary_primary = await runNativeAuxiliaryPrimaryGate(
        { ...context, output: join(context.output, "native-auxiliary-primary") },
        execute,
      );
      assert.equal(
        report.native_auxiliary_primary.status,
        "passed",
        "Native primary auxiliary gate failed",
      );
      report.native_surface_frames = await runNativeSurfaceFrameGate(
        { ...context, output: join(context.output, "native-surface-frames") },
        { binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(
        report.native_surface_frames.status,
        "passed",
        "Native complete surface frames failed",
      );
      report.native_layer_cache = await runNativeLayerCacheGate(
        { ...context, output: join(context.output, "native-layer-cache") },
        {
          binary,
          compiler,
          frames: report.frames,
          surfaceFrames: report.native_surface_frames.frames,
        },
        execute,
      );
      assert.equal(report.native_layer_cache.status, "passed", "Native layer cache changed pixels");
    }
    assert.equal(
      await hashFile(binary),
      report.binary.sha256,
      "Native binary changed during execution",
    );
    report.checked_files = await reader.stable();
    report.status = "passed";
    report.full_coverage = !effects;
    report.milestone_exit_eligible = !effects;
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.duration_ms = Date.now() - started;
  await mkdir(context.output, { recursive: true });
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
