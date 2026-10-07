import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export const nativeRasterCases = [
  "layer-text",
  "media-psd",
  "media-psd-layer",
  "media-svg",
  "scene-text-animators",
  "scene-motion-blur",
];

/** Execute supplied raster generations with the same plan and pixel provenance as core frames. */
export async function runNativeRasterBatch(context, inputs, execute) {
  const { reader, binary, base, manifest, corpus, compiler, validateReceipt } = inputs;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const jobs = [],
    frames = [],
    candidate = [];
  for (const id of nativeRasterCases) {
    const item = corpus.cases.find((c) => c.id === id);
    assert(item);
    const source = manifest.cases.find((c) => c.case_id === id);
    assert(source);
    const captured = await reader.json(`${base}/${source.path}`, source.capture_sha256);
    assert.deepEqual(captured.inputs.case, item);
    const cache = new Map();
    for (const frame of item.frames) {
      const capturedFrame = captured.frames.find((f) => f.frame === frame);
      assert(capturedFrame);
      const meta = await reader.json(`${base}/${id}/${frame}/meta.json`, capturedFrame.meta_sha256);
      await validateFrameArtifacts(
        async (path) => (await reader.bytes(`${base}/${id}/${path}`)).bytes,
        meta,
        item,
        manifest.source,
        cache,
      );
      const path = `${base}/${id}/${frame}/replay.fpln`;
      const plan = await reader.bytes(path);
      jobs.push({
        plan: path,
        resources: `${base}/${id}/frame-resources`,
        out: join(context.output, "native", id, `${frame}.png`),
      });
      frames.push({
        case_id: id,
        frame,
        input: { path, sha256: plan.sha256 },
        expected: { ...item.size, adapter: meta.adapter.gpuMemory.device },
      });
    }
  }
  const request = join(context.output, "raster-batch.json");
  await writeAtomicJson(request, jobs);
  const step = await execute(
    {
      id: "native-raster-batch",
      file: binary,
      args: ["render-plan", "--batch", request, ...(compiler ? ["--dxcompiler", compiler] : [])],
      timeout_ms: 120000,
    },
    context,
  );
  assert.equal(step.status, "passed", `Native rasters failed: ${step.log}`);
  const receipts = (await readFile(join(context.root, step.log), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{"schema_version":'))
    .map((line) => JSON.parse(line));
  assert.equal(receipts.length, frames.length);
  for (const [index, frame] of frames.entries()) {
    const receipt = receipts[index],
      path = local(jobs[index].out);
    const pixels = await reader.image(path);
    validateReceipt(receipt, {
      ...frame.expected,
      plan_sha256: frame.input.sha256,
      rgba_sha256: pixels.rgba_sha256,
    });
    assert.equal(receipt.frame_index, index);
    assert.equal(receipt.renderer_reused, index > 0);
    assert.equal(receipt.native_image_decode, false);
    assert(receipt.image_cache.uploads > 0 && receipt.image_cache.resident_bytes > 0);
    assert.equal(receipt.output, jobs[index].out);
    delete frame.expected;
    Object.assign(frame, { receipt, step, output: { path, sha256: pixels.png_sha256 } });
    candidate.push({
      case_id: frame.case_id,
      frame: frame.frame,
      path: relative(context.output, jobs[index].out).replaceAll("\\", "/"),
      png_sha256: pixels.png_sha256,
    });
  }
  const final = receipts.at(-1);
  assert(final.image_cache.hits > 0, "Static supplied rasters must reuse resident GPU pixels");
  return {
    cases: nativeRasterCases,
    frames,
    candidate,
    batch: {
      status: "passed",
      step,
      request: { path: local(request), sha256: await hashFile(request) },
      frames: frames.length,
      device_reuses: frames.length - 1,
      image_cache: final.image_cache,
    },
  };
}
