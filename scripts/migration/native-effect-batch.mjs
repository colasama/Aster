import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { nativeEffectCases, validateNativeEffectScope } from "./native-effect-scope.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Keep one GPU device while preserving per-frame plan, adapter and pixel provenance. */
export async function runNativeEffectBatch(context, inputs, execute) {
  const { reader, binary, base, manifest, corpus, compiler, validateReceipt } = inputs;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  validateNativeEffectScope(corpus);
  const jobs = [],
    frames = [],
    candidate = [];
  for (const id of nativeEffectCases) {
    const item = corpus.cases.find((value) => value.id === id);
    assert(item, `Missing native effect case: ${id}`);
    const source = manifest.cases.find((value) => value.case_id === id);
    assert(source, `Missing effect capture: ${id}`);
    const captured = await reader.json(`${base}/${source.path}`, source.capture_sha256);
    assert.deepEqual(captured.inputs.case, item);
    const cache = new Map();
    for (const frame of item.frames) {
      const record = captured.frames.find((value) => value.frame === frame);
      assert(record);
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
      jobs.push({ plan: input, resources: `${base}/${id}/frame-resources`, out: output });
      frames.push({
        case_id: id,
        frame,
        input: { path: input, sha256: plan.sha256 },
        expected: { ...item.size, adapter: meta.adapter.gpuMemory.device },
      });
    }
  }
  const path = join(context.output, "effect-batch.json");
  await writeAtomicJson(path, jobs);
  const batch = { path: local(path), sha256: await hashFile(path) };
  const step = await execute(
    {
      id: "native-effect-batch",
      file: binary,
      args: ["render-plan", "--batch", path, ...(compiler ? ["--dxcompiler", compiler] : [])],
      timeout_ms: 300_000,
    },
    context,
  );
  assert.equal(step.status, "passed", `Effect batch failed: ${step.log}`);
  const receipts = (await readFile(join(context.root, step.log), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{"schema_version":'))
    .map((line) => JSON.parse(line));
  assert.equal(receipts.length, frames.length);
  const lutFrames = new Map();
  for (const [index, frame] of frames.entries()) {
    const receipt = receipts[index],
      output = jobs[index].out;
    const pixels = await reader.image(local(output));
    validateReceipt(receipt, {
      ...frame.expected,
      plan_sha256: frame.input.sha256,
      rgba_sha256: pixels.rgba_sha256,
    });
    assert.equal(receipt.output, output);
    assert.equal(receipt.frame_index, index);
    assert.equal(receipt.renderer_reused, index > 0);
    assert.equal(receipt.native_image_decode, false);
    if (["effect-lut", "lut-tetrahedral"].includes(frame.case_id)) {
      assert(receipt.lut_cache.uploads > 0 && receipt.lut_cache.resident_bytes > 0);
      const previous = lutFrames.get(frame.case_id);
      if (previous) {
        assert.equal(receipt.lut_cache.uploads, previous.uploads);
        assert(
          receipt.lut_cache.hits > previous.hits,
          "Repeated LUT frame did not reuse its texture",
        );
      }
      lutFrames.set(frame.case_id, receipt.lut_cache);
    }
    delete frame.expected;
    Object.assign(frame, {
      step,
      receipt,
      output: { path: local(output), sha256: pixels.png_sha256 },
    });
    candidate.push({
      case_id: frame.case_id,
      frame: frame.frame,
      path: relative(context.output, output).replaceAll("\\", "/"),
      png_sha256: pixels.png_sha256,
    });
  }
  const rejections = [];
  for (const kind of ["duplicate", "limit", "partial"]) {
    const output = join(context.output, "batch-rejections", `${kind}.png`);
    const first = { ...jobs[0], out: output },
      failedOutput = join(context.output, "batch-rejections", "failed.png");
    const bad =
      kind === "partial"
        ? {
            plan: `${base}/scene-motion-blur/5/replay.fpln`,
            resources: `${base}/scene-motion-blur/frame-resources`,
            out: failedOutput,
          }
        : { ...first, out: kind === "duplicate" ? output : failedOutput };
    const request = join(context.output, `batch-reject-${kind}.json`);
    await writeAtomicJson(request, [first, bad]);
    const result = await execute(
      {
        id: `batch-reject-${kind}`,
        file: binary,
        args: [
          "render-plan",
          "--batch",
          request,
          ...(compiler ? ["--dxcompiler", compiler] : []),
          ...(kind === "limit" ? ["--max-batch-frames", "1"] : []),
        ],
      },
      context,
    );
    assert.equal(result.exit_code, 2);
    assert.equal(result.status, "failed");
    const lines = (await readFile(join(context.root, result.log), "utf8")).trim().split(/\r?\n/);
    const failure = JSON.parse(lines.at(-1));
    assert.match(
      failure.error,
      kind === "duplicate"
        ? /duplicate batch destination/
        : kind === "limit"
          ? /batch frame count/
          : /unsupported native feature/,
    );
    if (kind === "partial") {
      assert.equal(
        await hashFile(output),
        frames[0].output.sha256,
        "Completed frame changed on subsequent failure",
      );
    } else await assert.rejects(stat(output), { code: "ENOENT" });
    await assert.rejects(stat(failedOutput), { code: "ENOENT" });
    rejections.push({ id: kind, rejected: true, complete_frames_preserved: true, step: result });
  }
  await reader.bytes(batch.path, batch.sha256);
  return {
    status: "passed",
    cases: nativeEffectCases,
    frames,
    candidate,
    batch: {
      step,
      request: batch,
      frames: frames.length,
      device_reuses: frames.length - 1,
      rejections,
    },
  };
}
