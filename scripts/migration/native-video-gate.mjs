import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runNativeMediaCacheGate } from "./native-media-cache-gate.mjs";
import { runStillRejections } from "./native-still-rejections.mjs";
import { runNativeVideoControls } from "./native-video-controls.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export const nativeVideoCases = [
  "video-24000-1001",
  "video-24000-1001-seek",
  "video-30000-1001",
  "video-30000-1001-seek",
];

/** Native frame selection is independently checked against the frozen barcode corpus. */
export async function runNativeVideoGate(
  context,
  { base, binary, compiler, validateReceipt },
  execute = runStep,
) {
  const report = { status: "failed", native_video_decode: true, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const temporary = join(context.output, "decode-temporary");
    await mkdir(temporary);
    const execution = { ...context, env: { ...context.env, TEMP: temporary, TMP: temporary } };
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const corpus = await reader.json("tests/parity/corpus.json");
    assert.deepEqual(
      corpus.cases
        .filter((c) => c.features.includes("layer:video"))
        .map((c) => c.id)
        .sort(),
      [...nativeVideoCases].sort(),
    );
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe = join(context.root, "build/ffmpeg/ffprobe.exe");
    report.ffmpeg = { path: local(ffmpeg), sha256: await hashFile(ffmpeg) };
    report.ffprobe = { path: local(ffprobe), sha256: await hashFile(ffprobe) };
    const inputs = [],
      jobs = [],
      grants = new Map();
    for (const id of nativeVideoCases) {
      const rate = id.includes("24000") ? 24000 : 30000;
      const name = `barcode-${rate}-1001.mp4`,
        asset = catalog.assets[name];
      const path = join(context.output, `${id}.mp4`);
      await writeFile(path, Buffer.from(asset.data, "base64"), { flag: "wx" });
      await reader.bytes(local(path), asset.sha256);
      const item = corpus.cases.find((c) => c.id === id);
      for (const frame of item.frames) {
        const input = `${base}/${id}/${frame}/plan.fpln`,
          plan = await reader.bytes(input);
        const metadata = JSON.parse(plan.bytes.subarray(32, 32 + plan.bytes.readUInt32LE(8)));
        assert.equal(metadata.slices[0].media_pixels.length, 0);
        const messages = (await reader.json(`${base}/${id}/${frame}/resources.json`)).filter((m) =>
          metadata.resources.includes(m.hash),
        );
        assert.deepEqual(messages.map((m) => m.hash).sort(), metadata.resources);
        for (const m of messages) await reader.bytes(`${base}/${id}/frame-resources/${m.hash}.bin`);
        const source = messages.find((m) => m.kind === "media_source"),
          media = messages.find((m) => m.kind === "media_frame");
        assert.equal(source.descriptor.media_kind, "video");
        assert.equal(media.descriptor.sample.kind, "video");
        const grant = {
          source: source.hash,
          scope: source.descriptor.authorization_scope,
          path,
          sha256: asset.sha256,
        };
        grants.set(source.hash, grant);
        const dir = join(context.output, id, String(frame));
        await mkdir(dir, { recursive: true });
        const resourceManifest = join(dir, "resources.json");
        await writeAtomicJson(resourceManifest, messages);
        await reader.bytes(local(resourceManifest));
        const job = {
          plan: join(context.root, input),
          resources: join(context.root, base, id, "frame-resources"),
          resource_manifest: resourceManifest,
          out: join(dir, "frame.png"),
        };
        jobs.push(job);
        inputs.push({
          item,
          rate,
          frame,
          input,
          plan,
          source,
          media,
          asset,
          grant,
          job,
          meta: await reader.json(`${base}/${id}/${frame}/meta.json`),
        });
      }
    }
    assert.equal(inputs.length, 44);
    assert.equal(grants.size, 4);
    const authorization = join(context.output, "authorizations.json"),
      batch = join(context.output, "batch.json");
    await writeAtomicJson(authorization, [...grants.values()]);
    await reader.bytes(local(authorization));
    await writeAtomicJson(batch, jobs);
    report.request = { path: local(batch), sha256: await hashFile(batch) };
    const common = [
      "--media-authorizations",
      authorization,
      "--ffmpeg",
      ffmpeg,
      "--ffprobe",
      ffprobe,
      ...(compiler ? ["--dxcompiler", compiler] : []),
    ];
    const step = await execute(
      {
        id: "native-video-batch",
        file: binary,
        args: ["render-plan", "--batch", batch, ...common],
        timeout_ms: 300_000,
      },
      execution,
    );
    assert.equal(step.status, "passed", `Native video execution failed: ${step.log}`);
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{"schema_version":'))
      .map((l) => JSON.parse(l));
    assert.equal(receipts.length, inputs.length);
    const candidate = { schema_version: 1, frames: [] };
    for (const [i, receipt] of receipts.entries()) {
      const input = inputs[i],
        pixels = await reader.image(local(jobs[i].out));
      validateReceipt(receipt, {
        plan_sha256: input.plan.sha256,
        rgba_sha256: pixels.rgba_sha256,
        ...input.item.size,
        adapter: input.meta.adapter.gpuMemory.device,
      });
      assert.equal(receipt.native_image_decode, true);
      assert.equal(receipt.frame_index, i);
      assert.equal(receipt.renderer_reused, i > 0);
      assert.equal(receipt.output, jobs[i].out);
      assert.equal(receipt.native_images.length, 1);
      assert.equal(receipt.native_videos.length, 1);
      const decoded = receipt.native_images[0],
        video = receipt.native_videos[0];
      assert.equal(decoded.source, input.source.hash);
      assert.equal(decoded.frame, input.media.hash);
      assert.equal(decoded.source_sha256, input.asset.sha256);
      assert.equal(decoded.backend, "ffmpeg-video-snapshot");
      assert.equal(decoded.width, input.media.descriptor.width);
      assert.equal(decoded.height, input.media.descriptor.height);
      assert.equal(decoded.format, "rgba8unorm-srgb");
      assert.equal(video.frame, input.media.hash);
      assert.equal(video.frame_index, input.frame);
      assert.equal(video.presentation_timestamp, input.frame * 1001);
      assert.equal(video.duration, 1001);
      assert.deepEqual(video.timebase, { numerator: 1, denominator: input.rate });
      for (const key of ["requested_time", "uploaded_time"])
        assert.deepEqual(video[key], input.media.descriptor.sample[key]);
      assert.deepEqual(video.color, {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      });
      assert.equal(video.source_pixel_format, "yuv420p");
      assert.equal(video.measured_interop, "cpu_copy");
      assert(receipt.image_cache.resident_bytes > 0);
      candidate.frames.push({
        case_id: input.item.id,
        frame: input.frame,
        path: relative(context.output, jobs[i].out).replaceAll("\\", "/"),
        png_sha256: pixels.png_sha256,
      });
      report.frames.push({
        case_id: input.item.id,
        frame: input.frame,
        input: { path: input.input, sha256: input.plan.sha256 },
        grant: input.grant,
        receipt,
        output: { path: local(jobs[i].out), sha256: pixels.png_sha256 },
      });
    }
    report.batch = { step, frames: receipts.length, device_reuses: receipts.length - 1 };
    report.decode_cache = await runNativeMediaCacheGate(
      execution,
      { inputs, receipts, binary, common, reader },
      execute,
    );
    const first = inputs[0];
    report.rejections = await runStillRejections(
      execution,
      {
        binary,
        grant: first.grant,
        sourceBudget: "--video-max-source-bytes",
        pixelBudget: "--video-max-pixel-bytes",
        pixelPattern: /decoded video exceeds extent or byte budget/,
        args: [
          "render-plan",
          "--plan",
          first.job.plan,
          "--resources",
          first.job.resources,
          "--resource-manifest",
          first.job.resource_manifest,
          ...common,
        ],
        extraRejections: [
          [
            "video-index-budget",
            [first.grant],
            ["--video-max-index-bytes", "1024"],
            /exceeded its 1024 byte limit/,
          ],
          ["video-timeout", [first.grant], ["--video-timeout-ms", "1"], /timeout/],
        ],
      },
      execute,
    );
    report.timing_controls = await runNativeVideoControls(
      execution,
      { reader, original: first, binary, common },
      execute,
    );
    assert.deepEqual(await readdir(temporary), [], "Native video left private snapshot files");
    report.snapshot_cleanup = {
      directory: local(temporary),
      empty_after_success_and_rejections: true,
    };
    const candidatePath = join(context.output, "candidate.json");
    await writeAtomicJson(candidatePath, candidate);
    report.candidate_manifest = {
      path: local(candidatePath),
      sha256: await hashFile(candidatePath),
    };
    report.pixels = await runPixelGate(
      { ...context, output: join(context.output, "pixels") },
      { manifestPath: candidatePath, scope: "diagnostic", profileOverride: "decode" },
      execute,
    );
    assert.equal(report.pixels.status, "passed", "Native video pixels need acceptance");
    for (const tool of [report.ffmpeg, report.ffprobe])
      assert.equal(await hashFile(join(context.root, tool.path)), tool.sha256);
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
