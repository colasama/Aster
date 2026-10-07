import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export async function runNativeMaterialGate(
  context,
  { binary, compiler, validateReceipt, normal = false },
  execute = runStep,
) {
  const report = { status: "failed", frames: [], batches: [], exact_cache_comparisons: 0 };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pin = ledger.reference_baseline[normal ? "native_normal" : "native_material"];
    assert(pin, "Material output references must be captured independently and pinned");
    const manifest = await reader.json(pin.path, pin.sha256);
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.frames.length, normal ? 144 : 60);
    assert.equal(manifest.controls.length, normal ? 108 : 44);
    assert(manifest.controls.every((c) => c.changed_bytes > 16));
    const gpu = manifest.gpu_info.gpuDevice.find((g) => g.active);
    assert(gpu, "Captured TS adapter absent");
    const adapter = { name: gpu.deviceString, vendorId: gpu.vendorId, deviceId: gpu.deviceId };
    const expected = normal
      ? ["directional", "point", "spot"].flatMap((light) =>
          ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
            ["png", "jpeg", "webp"].flatMap((encoding) =>
              ["normal", "negative", "zero", "combined"].map((mode) => ({
                light,
                aa,
                encoding,
                mode,
              })),
            ),
          ),
        )
      : ["directional", "point", "spot"].flatMap((light) =>
          ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
            ["fallback", "hdr", "rotated", "replaced", "unshadowed"].map((mode) => ({
              light,
              aa,
              mode,
            })),
          ),
        );
    for (const [index, f] of manifest.frames.entries()) {
      assert.deepEqual(
        Object.fromEntries(Object.keys(expected[index]).map((k) => [k, f[k]])),
        expected[index],
      );
      assert.equal(f.repeated_exact, true);
      await reader.bytes(f.plan.path, f.plan.sha256);
      await reader.bytes(f.reference.path, f.reference.sha256);
      assert.deepEqual(
        await reader.json(`${dirname(f.plan.path)}/resources.json`),
        f.resources.map((r) => r.message),
      );
      for (const r of f.resources) await reader.bytes(r.path, r.sha256);
    }
    const frames = manifest.frames;
    report.coverage = normal
      ? {
          supported_encodings: ["png", "jpeg", "webp"],
          deferred_encodings: [],
          required_frames: 144,
          deferred_jpeg_frames: 0,
        }
      : { required_frames: 60 };
    assert.equal(frames.length, normal ? 144 : 60);
    report.reference = pin;
    report.controls = manifest.controls;
    const receiptsByMode = [],
      pathsByMode = [];
    for (const cached of [false, true]) {
      const mode = cached ? "cached" : "uncached";
      const jobs = frames.map((f) => ({
        plan: join(context.root, f.plan.path),
        resources: join(context.root, dirname(f.resources[0].path)),
        out: join(context.output, mode, `${f.id}.png`),
      }));
      const path = join(context.output, `${mode}.json`);
      await writeAtomicJson(path, jobs);
      const step = await execute(
        {
          id: `native-material-${mode}`,
          file: binary,
          args: [
            "render-plan",
            "--batch",
            path,
            "--layer-cache-bytes",
            cached ? "67108864" : "0",
            ...(compiler ? ["--dxcompiler", compiler] : []),
            ...(normal ? ["--texture-ffmpeg", join(context.root, "build/ffmpeg/ffmpeg.exe")] : []),
          ],
          timeout_ms: 180000,
        },
        context,
      );
      report.batches.push({ step, request: { path: local(path), sha256: await hashFile(path) } });
      assert.equal(step.status, "passed", step.log);
      const receipts = (await readFile(join(context.root, step.log), "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"schema_version":'))
        .map((line) => JSON.parse(line));
      assert.equal(receipts.length, jobs.length);
      receiptsByMode.push(receipts);
      pathsByMode.push(jobs.map((j) => j.out));
      for (const [index, f] of frames.entries()) {
        const receipt = receipts[index],
          pixels = await reader.image(local(jobs[index].out));
        validateReceipt(receipt, {
          width: f.width,
          height: f.height,
          adapter,
          plan_sha256: f.plan.sha256,
          rgba_sha256: pixels.rgba_sha256,
        });
        assert.equal(receipt.frame_index, index);
        assert.equal(receipt.renderer_reused, index > 0);
        assert.equal(receipt.motion_reconstruction.passes, 0);
        assert.equal(receipt.depth_effects.passes, 0);
        if (normal) {
          assert.equal(receipt.native_textures.length, 1);
          const decoded = receipt.native_textures[0];
          assert.equal(decoded.encoded, f.normal);
          assert.equal(decoded.encoding, f.encoding);
          assert.equal(decoded.width, 3);
          assert.equal(decoded.height, 2);
          const fixture = (
            await reader.json("tests/parity/assets/normal-textures.json")
          ).fixtures.find((t) => t.message.hash === f.normal);
          assert(fixture);
          assert.equal(decoded.rgba_sha256, fixture.rgba_sha256);
          assert.equal(
            decoded.backend,
            f.encoding === "png"
              ? "ffmpeg-inline-texture"
              : f.encoding === "jpeg"
                ? "windows-wic-jpeg-texture"
                : "rust-webp-texture",
          );
          assert.equal(
            receipt.texture_decode_cache.decodes,
            Math.min(3, 1 + Math.floor(index / 4)),
          );
          assert.equal(
            receipt.texture_decode_cache.resident_bytes,
            receipt.texture_decode_cache.decodes * 24,
          );
          assert.equal(
            receipt.texture_decode_cache.hits,
            index + 1 - receipt.texture_decode_cache.decodes,
          );
          assert.equal(
            receipt.image_cache.uploads,
            receipt.texture_decode_cache.decodes + Number(index >= 3),
          );
          assert.equal(
            receipt.image_cache.resident_bytes,
            receipt.texture_decode_cache.resident_bytes + (index >= 3 ? 256 : 0),
          );
        } else {
          const uploads = index === 0 ? 0 : index < 3 ? 1 : 2;
          assert.equal(receipt.image_cache.uploads, uploads);
          assert.equal(receipt.image_cache.resident_bytes, uploads * 256);
          if (["hdr", "rotated"].includes(f.mode) && index > 1)
            assert(receipt.image_cache.hits > 0);
        }
        if (cached) {
          assert.equal(pixels.rgba_sha256, receiptsByMode[0][index].rgba_sha256);
          report.exact_cache_comparisons++;
        }
      }
    }
    for (const [index, f] of frames.entries()) {
      const caseId = `native-${normal ? "normal" : "material"}-${f.id}`;
      const ctx = join(context.output, `${f.id}.context.json`),
        out = join(context.output, f.id);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-${f.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, f.reference.path),
            "--candidate",
            pathsByMode[0][index],
            "--tolerance",
            "gpu",
            "--context",
            ctx,
            "--out",
            out,
          ],
        },
        context,
      );
      assert.equal(step.status, "passed", `Material output pixels failed: ${f.id}`);
      const evidence = local(join(out, "report.json")),
        result = await reader.json(evidence);
      assert.equal(result.comparison.passed, true);
      assert.equal(result.comparison.reference_rgba_sha256, f.reference.rgba_sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, receiptsByMode[0][index].rgba_sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence,
        step,
        receipts: receiptsByMode.map((r) => r[index]),
      });
    }
    const f = frames.find((f) => f.mode === (normal ? "combined" : "hdr")),
      out = join(context.output, "budget-rejected.png");
    report.budget_rejection = await execute(
      {
        id: "material-budget",
        file: binary,
        args: [
          "render-plan",
          "--plan",
          join(context.root, f.plan.path),
          "--resources",
          join(context.root, dirname(f.resources[0].path)),
          "--out",
          out,
          "--gpu-budget-bytes",
          "16",
          ...(compiler ? ["--dxcompiler", compiler] : []),
          ...(normal ? ["--texture-ffmpeg", join(context.root, "build/ffmpeg/ffmpeg.exe")] : []),
        ],
      },
      context,
    );
    assert.equal(report.budget_rejection.exit_code, 2);
    assert.match(
      await readFile(join(context.root, report.budget_rejection.log), "utf8"),
      /GPU allocation budget/,
    );
    await assert.rejects(stat(out), { code: "ENOENT" });
    for (const frame of report.frames)
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === frame.case_id &&
            r.frame === 0 &&
            r.profile === "gpu" &&
            r.verdict === "accepted" &&
            r.reference_rgba_sha256 === frame.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === frame.comparison.candidate_rgba_sha256,
        ),
        `Self-review missing: ${frame.case_id}`,
      );
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
