import assert from "node:assert/strict";
import { mediaLocal, mediaReceipts } from "./m6-media.mjs";

/** Recompute admission and eviction accounting from actual requests, including disabled retention. */
export function validateMediaCache(receipts, bytes, entries) {
  const cache = new Map();
  let resident = 0,
    hits = 0,
    misses = 0,
    evictions = 0;
  for (const receipt of receipts) {
    const frame = receipt.native_images[0];
    const size = frame.width * frame.height * 4;
    if (cache.has(frame.frame)) {
      hits++;
      cache.delete(frame.frame);
      cache.set(frame.frame, size);
    } else {
      misses++;
      if (entries > 0 && size <= bytes) {
        while (resident + size > bytes || cache.size >= entries) {
          const oldest = cache.keys().next().value;
          resident -= cache.get(oldest);
          cache.delete(oldest);
          evictions++;
        }
        cache.set(frame.frame, size);
        resident += size;
      }
    }
    assert.deepEqual(receipt.media_decode_cache, {
      budget_bytes: bytes,
      entry_limit: entries,
      resident_bytes: resident,
      entries: cache.size,
      hits,
      misses,
      decodes: misses,
      evictions,
    });
  }
}

export async function auditMediaCache(reader, video, report) {
  const group = video.decode_cache;
  assert.equal(group.status, "passed");
  assert.deepEqual(
    group.modes.map((m) => m.id),
    ["retained", "disabled", "byte-pressure", "entry-pressure"],
  );
  let compared = 0;
  for (const mode of group.modes) {
    const receipts = await mediaReceipts(reader, mode.step, report);
    const jobs = await reader.json(mode.request.path, mode.request.sha256);
    assert.equal(
      mediaLocal(reader, mode.step.command[mode.step.command.indexOf("--batch") + 1]),
      mode.request.path,
    );
    const all = video.frames.map((_, i) => i);
    const indices =
      mode.id === "retained"
        ? [...all, ...all.toReversed()]
        : mode.id === "disabled"
          ? all
          : [0, 1, 0, 2, 1, 0, 3, 0];
    assert.equal(receipts.length, indices.length);
    assert.equal(jobs.length, receipts.length);
    assert.equal(mode.frames.length, receipts.length);
    for (const [i, receipt] of receipts.entries()) {
      const expected = video.frames[indices[i]];
      assert.deepEqual(receipt, mode.frames[i].receipt);
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.native_gpu_execution, true);
      assert.equal(receipt.frame_index, i);
      assert.equal(receipt.renderer_reused, i > 0);
      assert.equal(receipt.output, jobs[i].out);
      assert.equal(receipt.plan_sha256, expected.receipt.plan_sha256);
      assert.equal(
        (await reader.bytes(mediaLocal(reader, jobs[i].plan))).sha256,
        receipt.plan_sha256,
      );
      assert.deepEqual(receipt.adapter, expected.receipt.adapter);
      assert.deepEqual(receipt.native_images, expected.receipt.native_images);
      assert.deepEqual(receipt.native_videos, expected.receipt.native_videos);
      const image = await reader.image(mode.frames[i].output.path, mode.frames[i].output.sha256);
      assert.equal(image.rgba_sha256, expected.receipt.rgba_sha256);
      assert.equal(receipt.rgba_sha256, image.rgba_sha256);
      assert.equal(mediaLocal(reader, receipt.output), mode.frames[i].output.path);
    }
    const bytes = mode.id === "disabled" ? 0 : mode.id === "byte-pressure" ? 49152 : 67108864;
    const entries = mode.id === "entry-pressure" ? 2 : 256;
    assert.equal(
      Number(mode.step.command[mode.step.command.indexOf("--media-cache-bytes") + 1]),
      bytes,
    );
    assert.equal(
      Number(mode.step.command[mode.step.command.indexOf("--media-cache-entries") + 1]),
      entries,
    );
    validateMediaCache(receipts, bytes, entries);
    assert.deepEqual(mode.final_cache, receipts.at(-1).media_decode_cache);
    compared += receipts.length;
  }
  assert.equal(group.exact_comparisons, compared);
  return { exact_comparisons: compared, modes: group.modes.length };
}
