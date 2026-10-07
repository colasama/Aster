import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Native file pixels and supplied text samples must meet in the same recursive GPU frame. */
export async function runNativeMediaFrameGate(context, { binary, compiler }, execute = runStep) {
  const report = { status: "failed", frames: [], controls: [], self_reviews: [] };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_media_frame;
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
    assert.equal(capture.status, "passed");
    assert.deepEqual(manifest.gpu_info, capture.gpu_info);
    assert.deepEqual(
      manifest.frames.map((f) => f.id),
      ["root-0", "root-1", "root-2", "recursive-0", "recursive-1", "recursive-2"],
    );
    const device = manifest.gpu_info.gpuDevice.find((d) => d.active);
    assert(device && device.vendorId !== 5140);
    const base = dirname(frozen.path);
    const catalog = await reader.json("tests/parity/assets/media-assets.json");
    const tolerance = await reader.bytes("tests/parity/tolerances.json");
    const grants = new Map(),
      jobs = [];
    const assets = new Map();
    for (const frame of manifest.frames) {
      const original = capture.frames.find((f) => f.id === frame.id);
      assert(original);
      assert.equal(frame.independent_device_exact, true);
      assert.equal(frame.plan.sha256, original.plan.sha256);
      assert.equal(frame.replay.sha256, original.replay.sha256);
      assert.deepEqual(frame.temporal, original.temporal);
      assert.equal(frame.surfaces, frame.mode === "recursive" ? 2 : 0);
      assert.equal(frame.temporal.passes, 1);
      assert.equal(frame.temporal.samples, 8);
      assert.equal(frame.reference.sha256, original.reference.sha256);
      assert.deepEqual(frame.resources, original.resources);
      const plan = await reader.bytes(frame.plan.path, frame.plan.sha256);
      await reader.bytes(frame.replay.path, frame.replay.sha256);
      await reader.image(frame.reference.path, frame.reference.sha256);
      const metadata = JSON.parse(plan.bytes.subarray(32, 32 + plan.bytes.readUInt32LE(8)));
      const messages = await reader.json(`${base}/${frame.id}/resources.json`);
      assert.deepEqual(
        messages,
        frame.resources
          .filter((r) => metadata.resources.includes(r.message.hash))
          .map((r) => r.message),
      );
      for (const resource of frame.resources)
        await reader.bytes(`${base}/resources/${resource.message.hash}.bin`, resource.sha256);
      const frames = messages.filter((m) => m.kind === "media_frame");
      assert(frames.some((m) => m.descriptor.sample.kind === "raster"));
      assert.equal(frames.filter((m) => m.descriptor.sample.kind === "image").length, 1);
      assert.equal(frames.filter((m) => m.descriptor.sample.kind === "video").length, 1);
      for (const pixel of metadata.slices[0].media_pixels)
        assert.equal(frames.find((m) => m.hash === pixel.frame)?.descriptor.sample.kind, "raster");
      for (const source of messages.filter(
        (m) => m.kind === "media_source" && m.descriptor.media_kind !== "raster",
      )) {
        const name = source.descriptor.source_id;
        assert(["pattern.png", "barcode-24000-1001.mp4"].includes(name));
        const asset = catalog.assets[name];
        assert.equal(source.descriptor.content_identity, `sha256:${asset.sha256}`);
        if (!assets.has(name)) {
          const path = join(context.output, name);
          await writeFile(path, Buffer.from(asset.data, "base64"), { flag: "wx" });
          await reader.bytes(local(path), asset.sha256);
          assets.set(name, path);
        }
        grants.set(source.hash, {
          source: source.hash,
          scope: source.descriptor.authorization_scope,
          path: assets.get(name),
          sha256: asset.sha256,
        });
      }
      jobs.push({
        plan: join(context.root, frame.plan.path),
        resources: join(context.root, base, "resources"),
        out: join(context.output, `${frame.id}.png`),
      });
    }
    const authorization = join(context.output, "authorizations.json");
    await writeAtomicJson(authorization, [...grants.values()]);
    const ffmpeg = join(context.root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe = join(context.root, "build/ffmpeg/ffprobe.exe");
    report.tools = await Promise.all(
      [ffmpeg, ffprobe].map(async (path) => ({ path: local(path), sha256: await hashFile(path) })),
    );
    const common = [
      "--media-authorizations",
      authorization,
      "--ffmpeg",
      ffmpeg,
      "--ffprobe",
      ffprobe,
      ...(compiler ? ["--dxcompiler", compiler] : []),
    ];
    const batch = join(context.output, "batch.json");
    await writeAtomicJson(batch, jobs);
    const step = await execute(
      {
        id: "native-mixed-media",
        file: binary,
        args: ["render-plan", "--batch", batch, ...common],
        timeout_ms: 120000,
      },
      context,
    );
    report.batch = step;
    assert.equal(step.status, "passed");
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{"schema_version":'))
      .map((l) => JSON.parse(l));
    assert.equal(receipts.length, jobs.length);
    for (const [index, frame] of manifest.frames.entries()) {
      const receipt = receipts[index],
        image = await reader.image(local(jobs[index].out));
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.native_gpu_execution, true);
      assert.equal(receipt.native_image_decode, true);
      assert.equal(receipt.native_images.length, 2);
      assert.equal(receipt.native_videos.length, 1);
      assert.equal(receipt.adapter.vendor, device.vendorId);
      assert.equal(receipt.adapter.device, device.deviceId);
      assert.notEqual(receipt.adapter.device_type, "Cpu");
      assert.equal(receipt.plan_sha256, frame.plan.sha256);
      assert.equal(receipt.rgba_sha256, image.rgba_sha256);
      assert.equal(receipt.output, jobs[index].out);
      assert.equal(receipt.temporal_cache.passes, 1);
      assert.equal(receipt.temporal_cache.samples, 8);
      for (const decoded of receipt.native_images) {
        assert.equal(decoded.source_sha256, grants.get(decoded.source).sha256);
        assert.notEqual(decoded.backend, "");
      }
      const sample = Number(frame.id.at(-1));
      const expectedVideo = sample === 1 ? 23 : 11;
      assert.equal(receipt.native_videos[0].frame_index, expectedVideo);
      const caseId = `native-media-frame-${frame.mode}`;
      const siblings = manifest.frames.filter((f) => f.mode === frame.mode);
      const ctx = join(context.output, `${frame.id}.context.json`);
      await writeAtomicJson(ctx, {
        case_id: caseId,
        isolated: true,
        background: [0, 0, 0, 0],
        sequence: {
          frame: sample,
          first_frame: 0,
          last_frame: 2,
          previous: sample ? join(context.root, siblings[sample - 1].reference.path) : null,
          next: sample < 2 ? join(context.root, siblings[sample + 1].reference.path) : null,
        },
      });
      const out = join(context.output, `compare-${frame.id}`);
      const compared = await execute(
        {
          id: `compare-mixed-${frame.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, frame.reference.path),
            "--candidate",
            jobs[index].out,
            "--tolerance",
            "decode",
            "--context",
            ctx,
            "--out",
            out,
          ],
        },
        context,
      );
      const evidence = local(join(out, "report.json")),
        result = await reader.json(evidence);
      const comparison = result.comparison;
      report.frames.push({
        step: compared,
        case_id: caseId,
        frame: sample,
        receipt,
        evidence,
        comparison,
        output: { path: local(jobs[index].out), sha256: image.png_sha256 },
      });
      assert.equal(compared.status, "passed");
      assert.equal(comparison.passed, true);
      assert.equal(comparison.profile.name, "decode");
      assert.equal(comparison.profile.catalog_sha256, tolerance.sha256);
      assert.equal(comparison.reference_rgba_sha256, frame.reference.rgba_sha256);
      assert.equal(comparison.candidate_rgba_sha256, image.rgba_sha256);
      assert.deepEqual(
        comparison.checks.map((c) => c.id).sort(),
        [
          "max_abs_channel_error",
          "mean_abs_error",
          "psnr",
          "error_clusters",
          "signed_bias",
          "alpha_coverage",
          "registration",
          "ink_bounds",
          "frame_identity",
        ].sort(),
      );
      report.self_reviews.push(
        await reviewStatus(
          { context, ledger, bytes: (path) => reader.bytes(local(path)) },
          { case_id: caseId, frame: sample, profile: "decode" },
          result,
        ),
      );
    }
    for (const index of [0, 3]) {
      const frame = manifest.frames[index],
        out = join(context.output, `rejected-${frame.mode}.png`);
      const step = await execute(
        {
          id: `reject-supplied-file-media-${frame.mode}`,
          file: binary,
          args: [
            "render-plan",
            "--plan",
            join(context.root, frame.replay.path),
            "--resources",
            jobs[index].resources,
            "--resource-manifest",
            join(context.root, base, frame.id, "replay-resources.json"),
            "--out",
            out,
            ...common,
          ],
        },
        context,
      );
      assert.equal(step.exit_code, 2);
      assert.match(
        await readFile(join(context.root, step.log), "utf8"),
        /cannot accept supplied file-media pixels/,
      );
      await assert.rejects(stat(out), { code: "ENOENT" });
      report.controls.push({ id: frame.mode, step, rejected: true, output_absent: true });
    }
    for (const tool of report.tools)
      assert.equal(await hashFile(join(context.root, tool.path)), tool.sha256);
    assert(
      report.self_reviews.every((r) => r.status === "passed"),
      "Mixed media pixels require self-review",
    );
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
