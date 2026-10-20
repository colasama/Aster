import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { nativeReleaseBuild } from "../native-build.mjs";
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
import { runNativeRgbSupplement } from "./native-corpus-rgb.mjs";
import { runNativeElectronSessionGate } from "./native-electron-session-gate.mjs";
import { runNativeExportJobGate } from "./native-export-job-gate.mjs";
import { runNativeExportStreamGate } from "./native-export-stream-gate.mjs";
import { runNativeGeneratorAudioGate } from "./native-generator-audio-gate.mjs";
import { runNativeGeneratorOutputGate } from "./native-generator-output-gate.mjs";
import { runNativeGeneratorSurfaceGate } from "./native-generator-surface-gate.mjs";
import { runNativeMaterialGate } from "./native-material-gate.mjs";
import { runNativeMediaFrameGate } from "./native-media-frame-gate.mjs";
import { runNativeMotionFrameGate } from "./native-motion-frame-gate.mjs";
import { runNativeNv12Corpus } from "./native-nv12-corpus.mjs";
import { runNativePreflightMediaGate } from "./native-preflight-media-gate.mjs";
import { nativeSceneCases, runNativeSceneBatch } from "./native-scene-batch.mjs";
import { runNativeSceneOutputGate } from "./native-scene-output-gate.mjs";
import { runNativeSequenceGate } from "./native-sequence-gate.mjs";
import { runNativeSessionGate } from "./native-session-gate.mjs";
import { runNativeVideoGate } from "./native-video-gate.mjs";

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
import { nativeRasterCases, runNativeRasterBatch } from "./native-raster-batch.mjs";
import { runNativeSsaaEffectGate } from "./native-ssaa-effect-gate.mjs";
import { runNativeStillGate } from "./native-still-gate.mjs";
import { runNativeSurfaceFrameGate } from "./native-surface-frame-gate.mjs";
import { runNativeSurfacePostGate } from "./native-surface-post-gate.mjs";
import { runNativeTemporalFrameGate } from "./native-temporal-frame-gate.mjs";
import { runNativeTemporalGate } from "./native-temporal-gate.mjs";
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

/** Native gate coverage is scoped to the current milestone; its exit audit checks provenance. */
export async function runNativeCoreGate(context, execute = runStep) {
  const started = Date.now();
  const exportSession = context.milestone === "M8";
  const scenes = exportSession || ["M7", "M10"].includes(context.milestone);
  const media = scenes || context.milestone === "M6";
  const rasters = media || context.milestone === "M5";
  const effects = rasters || context.milestone === "M4";
  const extraCases = [
    ...(effects ? nativeEffectCases : []),
    ...(rasters ? nativeRasterCases : []),
    ...(scenes ? nativeSceneCases : []),
  ];
  const report = {
    id: "G3",
    status: "failed",
    scope: scenes
      ? "native-scene-depth-v1"
      : media
        ? "native-media-mixed-v1"
        : rasters
          ? "native-rasters-v1"
          : effects
            ? "native-effects-fused-v4"
            : "native-core-v5",
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
    if (rasters) assert.equal(ledger.milestones.find((item) => item.id === "M4").status, "done");
    report.pending_tasks = ledger.milestones
      .find((item) => item.id === context.milestone)
      .tasks.filter((task) => task.status !== "done")
      .map((task) => task.id);
    report.build = await execute(nativeReleaseBuild("native-core-build"), context);
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
    if (exportSession) {
      report.nv12_conversion_smoke = await execute(
        {
          id: "native-nv12-conversion",
          file: "cargo",
          args: ["test", "-p", "aster-renderer", "gpu_nv12_matches", "--", "--ignored"],
        },
        {
          ...context,
          env: { ...context.env, ASTER_NV12_EVIDENCE_DIR: join(context.output, "nv12-conversion") },
        },
      );
      assert.equal(
        report.nv12_conversion_smoke.status,
        "passed",
        "GPU NV12 conversion smoke failed",
      );
      report.nv12_sharing_smoke = await execute(
        {
          id: "native-nv12-sharing",
          file: "cargo",
          args: ["test", "-p", "aster-renderer", "shared_nv12_planes_are_exact", "--", "--ignored"],
        },
        context,
      );
      assert.equal(report.nv12_sharing_smoke.status, "passed", "GPU NV12 sharing smoke failed");
      report.native_session = await runNativeSessionGate(
        { ...context, output: join(context.output, "native-session") },
        { binary, compiler },
      );
      assert.equal(report.native_session.status, "passed", "Native session admission failed");
      report.native_export_stream = await runNativeExportStreamGate(
        { ...context, output: join(context.output, "native-export-stream") },
        { binary, compiler },
        execute,
      );
      assert.equal(report.native_export_stream.status, "passed", "Native export stream failed");
      report.native_shared_export_stream = await runNativeExportStreamGate(
        { ...context, output: join(context.output, "native-shared-export-stream") },
        { binary, compiler, transport: "auto" },
        execute,
      );
      assert.equal(
        report.native_shared_export_stream.status,
        "passed",
        "Native shared export stream failed",
      );
      assert.equal(
        report.native_shared_export_stream.decoded_output.sha256,
        report.native_export_stream.decoded_output.sha256,
        "Shared/readback transport changed decoded diagnostic pixels",
      );
      report.native_electron_session = await runNativeElectronSessionGate(
        { ...context, output: join(context.output, "native-electron-session") },
        { binary, compiler },
        execute,
      );
      assert.equal(
        report.native_electron_session.status,
        "passed",
        "Native Electron session failed",
      );
      assert.equal(
        report.native_electron_session.video_sha256,
        report.native_export_stream.decoded_output.sha256,
        "Electron mux changed native decoded diagnostic pixels",
      );
      report.native_preflight_media = await runNativePreflightMediaGate(
        { ...context, output: join(context.output, "native-preflight-media") },
        { binary, compiler },
        execute,
      );
      assert.equal(
        report.native_preflight_media.status,
        "passed",
        "Native media preflight/replay failed",
      );
      const planCapture = join(context.output, "native-plan-capture");
      report.native_plan_capture = await execute(
        {
          id: "native-plan-capture",
          file: "node",
          args: ["scripts/migration/native-media-frame-capture.mjs", planCapture],
          timeout_ms: 240000,
        },
        context,
      );
      assert.equal(report.native_plan_capture.status, "passed", "Native plan-only capture failed");
      const capturedPlans = JSON.parse(await readFile(join(planCapture, "report.json"), "utf8"));
      assert.equal(capturedPlans.status, "passed");
      assert.equal(capturedPlans.frames.length, 6);
      assert(
        capturedPlans.frames.every(
          (frame) =>
            frame.plan_only_exact &&
            frame.plan_only_final_output_accesses === 0 &&
            frame.plan_only_file_pixel_captures === 0,
        ),
      );
      const jobCapture = join(context.output, "native-job-capture");
      report.native_job_capture = await execute(
        {
          id: "native-job-capture",
          file: "node",
          args: ["scripts/migration/native-media-frame-capture.mjs", jobCapture],
          env: { ASTER_NATIVE_JOB_CAPTURE: "1" },
          timeout_ms: 240000,
        },
        context,
      );
      assert.equal(report.native_job_capture.status, "passed", "Native job capture failed");
      report.native_job = await runNativeExportJobGate(
        { ...context, output: join(context.output, "native-job") },
        { binary, compiler, capture: join(jobCapture, "report.json") },
        execute,
      );
      assert.equal(report.native_job.status, "passed", "Native whole-job routing failed");
      const untaggedOutput = join(context.output, "native-untagged-video");
      report.native_untagged_video_step = await execute(
        {
          id: "native-untagged-video",
          file: "node",
          args: ["scripts/migration/native-untagged-video-gate.mjs", "--out", untaggedOutput],
          timeout_ms: 300000,
        },
        context,
      );
      report.native_untagged_video = JSON.parse(
        await readFile(join(untaggedOutput, "report.json"), "utf8"),
      );
      assert.equal(
        report.native_untagged_video_step.status,
        "passed",
        report.native_untagged_video.error,
      );
      assert.equal(report.native_untagged_video.status, "passed");
    }
    if (media) {
      assert.equal(ledger.milestones.find((m) => m.id === "M5").status, "done");
      report.native_sequences = await runNativeSequenceGate(
        { ...context, output: join(context.output, "native-sequences") },
        { base, binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(report.native_sequences.status, "passed", "Native sequence decode failed");
      report.native_videos = await runNativeVideoGate(
        { ...context, output: join(context.output, "native-videos") },
        { base, binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(report.native_videos.status, "passed", "Native video decode failed");
      report.native_media_frames = await runNativeMediaFrameGate(
        { ...context, output: join(context.output, "native-media-frames") },
        { binary, compiler },
        execute,
      );
      assert.equal(report.native_media_frames.status, "passed", "Native mixed media failed");
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
    if (rasters) {
      const extra = await runNativeRasterBatch(
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
      report.raster_batch = extra.batch;
    }
    if (scenes) {
      const extra = await runNativeSceneBatch(
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
      report.scene_batch = extra.batch;
      report.native_generator_audio = await runNativeGeneratorAudioGate(
        { ...context, output: join(context.output, "native-generator-audio") },
        { binary, compiler, base, frames: extra.frames },
        execute,
      );
      assert.equal(
        report.native_generator_audio.status,
        "passed",
        "Native generator audio controls failed",
      );
      report.native_generator_output = await runNativeGeneratorOutputGate(
        { ...context, output: join(context.output, "native-generator-output") },
        { binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(
        report.native_generator_output.status,
        "passed",
        "Native generator output failed",
      );
      report.native_generator_surfaces = await runNativeGeneratorSurfaceGate(
        { ...context, output: join(context.output, "native-generator-surfaces") },
        { binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(
        report.native_generator_surfaces.status,
        "passed",
        "Recursive generators failed",
      );
      report.native_scene_output = await runNativeSceneOutputGate(
        { ...context, output: join(context.output, "native-scene-output") },
        { binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(report.native_scene_output.status, "passed", "Native scene output gate failed");
      report.native_material = await runNativeMaterialGate(
        { ...context, output: join(context.output, "native-material") },
        { binary, compiler, validateReceipt: validateNativeReceipt },
        execute,
      );
      assert.equal(report.native_material.status, "passed", "Native material gate failed");
      report.native_normal = await runNativeMaterialGate(
        { ...context, output: join(context.output, "native-normal") },
        { binary, compiler, validateReceipt: validateNativeReceipt, normal: true },
        execute,
      );
      assert.equal(report.native_normal.status, "passed", "Native normal texture gate failed");
      report.native_animated_normal = await runNativeMaterialGate(
        { ...context, output: join(context.output, "native-animated-normal") },
        { binary, compiler, validateReceipt: validateNativeReceipt, normal: "animated" },
        execute,
      );
      assert.equal(
        report.native_animated_normal.status,
        "passed",
        "Native animated normal gate failed",
      );
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
    assert.equal(
      report.pixels.status,
      "passed",
      "Native pixel comparison or self-review evidence failed",
    );
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
    if (rasters) {
      report.native_temporal_text = await runNativeTemporalGate(
        { ...context, output: join(context.output, "native-temporal-text") },
        binary,
        execute,
      );
      assert.equal(
        report.native_temporal_text.status,
        "passed",
        "Native temporal text gate failed",
      );
      report.native_temporal_frames = await runNativeTemporalFrameGate(
        { ...context, output: join(context.output, "native-temporal-frames") },
        {
          binary,
          compiler,
          adapter: report.frames[0].receipt.adapter.name,
          nonTemporal: report.frames.find((f) => f.case_id === "layer-text" && f.frame === 0),
        },
        execute,
      );
      assert.equal(
        report.native_temporal_frames.status,
        "passed",
        "Native temporal frame gate failed",
      );
    }
    if (rasters) {
      report.native_motion_frames = await runNativeMotionFrameGate(
        { ...context, output: join(context.output, "native-motion-frames") },
        {
          binary,
          compiler,
          adapter: report.frames[0].receipt.adapter.name,
          motionFrame: report.frames.find(
            (f) => f.case_id === "scene-motion-blur" && f.frame === 15,
          ),
          ordinaryFrame: report.frames.find((f) => f.case_id === "layer-text" && f.frame === 0),
        },
        execute,
      );
      assert.equal(report.native_motion_frames.status, "passed", "Native motion frame gate failed");
    }
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
      report.native_ssaa_effect_evaluation = await runNativeSsaaEffectGate(
        { ...context, output: join(context.output, "native-ssaa-effect-evaluation") },
        binary,
        execute,
      );
      assert.equal(
        report.native_ssaa_effect_evaluation.status,
        "passed",
        "SSAA effect safety control failed",
      );
    }
    if (exportSession) {
      report.native_nv12 = await runNativeNv12Corpus(
        { ...context, output: join(context.output, "native-nv12-corpus") },
        { binary, resume: context.nv12Resume },
        execute,
      );
      report.native_rgb_supplement = await runNativeRgbSupplement(
        context,
        corpus,
        report.frames,
        report.native_nv12,
        execute,
      );
      assert.equal(
        report.native_rgb_supplement.status,
        "passed",
        "Complete supplied RGB corpus comparison or self-review failed",
      );
      assert.equal(
        report.native_nv12.status,
        "passed",
        "Complete NV12 corpus conversion or self-review failed",
      );
      assert.equal(report.native_nv12.full_coverage, true);
    }
    assert.equal(
      await hashFile(binary),
      report.binary.sha256,
      "Native binary changed during execution",
    );
    report.checked_files = await reader.stable();
    report.status = "passed";
    report.full_coverage = true;
    report.milestone_exit_eligible = context.milestone !== "M10";
    if (context.milestone === "M10") report.native_text_acceptance = false;
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.duration_ms = Date.now() - started;
  await mkdir(context.output, { recursive: true });
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
