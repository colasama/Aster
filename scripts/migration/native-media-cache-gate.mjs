import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Exercise real decoding and GPU output across reuse, disabled retention and both eviction limits. */
export async function runNativeMediaCacheGate(context, options, execute) {
  const { inputs, receipts: reference, binary, common, reader } = options;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const indices = inputs.map((_, i) => i);
  const pressure = [0, 1, 0, 2, 1, 0, 3, 0];
  const frameBytes = inputs[0].media.descriptor.width * inputs[0].media.descriptor.height * 4;
  const modes = [
    {
      id: "retained",
      indices: [...indices, ...indices.toReversed()],
      bytes: 67108864,
      entries: 256,
    },
    { id: "disabled", indices, bytes: 0, entries: 256 },
    { id: "byte-pressure", indices: pressure, bytes: frameBytes * 2, entries: 256 },
    { id: "entry-pressure", indices: pressure, bytes: 67108864, entries: 2 },
  ];
  const report = { status: "failed", exact_comparisons: 0, modes: [] };
  for (const mode of modes) {
    const output = join(context.output, "decode-cache", mode.id);
    await mkdir(output, { recursive: true });
    const jobs = mode.indices.map((index, i) => ({
      ...inputs[index].job,
      out: join(output, `${i}.png`),
    }));
    const batch = join(output, "batch.json");
    await writeAtomicJson(batch, jobs);
    const request = { path: local(batch), sha256: await hashFile(batch) };
    const step = await execute(
      {
        id: `native-media-cache-${mode.id}`,
        file: binary,
        args: [
          "render-plan",
          "--batch",
          batch,
          ...common,
          "--media-cache-bytes",
          String(mode.bytes),
          "--media-cache-entries",
          String(mode.entries),
        ],
        timeout_ms: 300_000,
      },
      { ...context, output },
    );
    assert.equal(step.status, "passed");
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, jobs.length);
    const cache = new Map();
    let hits = 0,
      misses = 0,
      evictions = 0,
      resident = 0;
    const frames = [];
    for (const [i, receipt] of receipts.entries()) {
      const index = mode.indices[i],
        input = inputs[index],
        expected = reference[index];
      const frame = input.media.hash;
      const pixels = await reader.image(local(jobs[i].out));
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.plan_sha256, expected.plan_sha256);
      assert.equal(receipt.output, jobs[i].out);
      assert.equal(receipt.frame_index, i);
      assert.equal(receipt.renderer_reused, i > 0);
      assert.deepEqual(receipt.adapter, expected.adapter);
      assert.equal(receipt.rgba_sha256, expected.rgba_sha256);
      assert.equal(pixels.rgba_sha256, expected.rgba_sha256);
      assert.deepEqual(receipt.native_images, expected.native_images);
      assert.deepEqual(receipt.native_videos, expected.native_videos);
      const bytes = input.media.descriptor.width * input.media.descriptor.height * 4;
      if (cache.has(frame)) {
        hits++;
        cache.delete(frame);
        cache.set(frame, bytes);
      } else {
        misses++;
        if (mode.entries > 0 && bytes <= mode.bytes) {
          while (resident + bytes > mode.bytes || cache.size >= mode.entries) {
            const oldest = cache.keys().next().value;
            resident -= cache.get(oldest);
            cache.delete(oldest);
            evictions++;
          }
          cache.set(frame, bytes);
          resident += bytes;
        }
      }
      assert.deepEqual(receipt.media_decode_cache, {
        budget_bytes: mode.bytes,
        entry_limit: mode.entries,
        resident_bytes: resident,
        entries: cache.size,
        hits,
        misses,
        decodes: misses,
        evictions,
      });
      frames.push({
        case_id: input.item.id,
        frame: input.frame,
        receipt,
        output: { path: local(jobs[i].out), sha256: pixels.png_sha256 },
      });
    }
    if (mode.id === "retained") assert(hits >= inputs.length);
    if (mode.id.endsWith("pressure")) assert(hits > 0 && evictions > 0);
    report.exact_comparisons += jobs.length;
    report.modes.push({
      id: mode.id,
      step,
      request,
      frames,
      final_cache: receipts.at(-1).media_decode_cache,
    });
  }
  report.status = "passed";
  await writeAtomicJson(join(context.output, "decode-cache", "report.json"), report);
  return report;
}
