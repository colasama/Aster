import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Cold pixel decodes isolate source-index reuse, its limits and private-file cleanup. */
export async function runNativeVideoSourceCacheGate(
  context,
  { inputs, receipts: reference, binary, common, reader },
  execute = runStep,
) {
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const first = 0,
    other = inputs.findIndex((input) => input.source.hash !== inputs[first].source.hash);
  assert(other > 0, "Distinct authorized video sources are required");
  const indices = [first, first, other, other, first, other];
  const report = { status: "failed", exact_comparisons: 0, modes: [] };
  for (const mode of [
    { id: "retained", bytes: 268435456, entries: 8 },
    { id: "disabled", bytes: 0, entries: 8 },
    { id: "byte-pressure", bytes: 1, entries: 8 },
    { id: "entry-pressure", bytes: 268435456, entries: 1 },
  ]) {
    const output = join(context.output, "source-cache", mode.id);
    const temporary = join(output, "temporary");
    await mkdir(temporary, { recursive: true });
    const jobs = indices.map((index, i) => ({
      ...inputs[index].job,
      out: join(output, `${i}.png`),
    }));
    const batch = join(output, "batch.json");
    await writeAtomicJson(batch, jobs);
    const step = await execute(
      {
        id: `video-source-${mode.id}`,
        file: binary,
        args: [
          "render-plan",
          "--batch",
          batch,
          ...common,
          "--media-cache-bytes",
          "0",
          "--video-snapshot-cache-bytes",
          String(mode.bytes),
          "--video-snapshot-cache-entries",
          String(mode.entries),
        ],
        timeout_ms: 120000,
      },
      { ...context, output, env: { ...context.env, TEMP: temporary, TMP: temporary } },
    );
    assert.equal(step.status, "passed");
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, jobs.length);
    const cache = new Map();
    let probes = 0,
      hits = 0,
      evictions = 0;
    const frames = [];
    for (const [i, receipt] of receipts.entries()) {
      const index = indices[i],
        source = inputs[index].source.hash;
      const image = await reader.image(local(jobs[i].out));
      assert.equal(receipt.rgba_sha256, reference[index].rgba_sha256);
      assert.equal(image.rgba_sha256, reference[index].rgba_sha256);
      assert.deepEqual(receipt.native_videos, reference[index].native_videos);
      assert.equal(receipt.media_decode_cache.hits, 0);
      assert.equal(receipt.media_decode_cache.decodes, i + 1);
      if (cache.has(source)) {
        hits++;
        cache.delete(source);
        cache.set(source, true);
      } else {
        probes++;
        if (mode.bytes > 1) {
          if (cache.size === mode.entries) {
            cache.delete(cache.keys().next().value);
            evictions++;
          }
          cache.set(source, true);
        }
      }
      const stats = receipt.video_source_cache;
      assert.deepEqual(
        { ...stats, resident_bytes: 0 },
        { resident_bytes: 0, entries: cache.size, hits, probes, evictions },
      );
      assert(stats.resident_bytes <= mode.bytes);
      assert.equal(stats.resident_bytes > 0, cache.size > 0);
      frames.push({ output: { path: local(jobs[i].out), sha256: image.png_sha256 }, receipt });
    }
    assert.deepEqual(await readdir(temporary), []);
    report.exact_comparisons += receipts.length;
    report.modes.push({
      ...mode,
      step,
      request: { path: local(batch), sha256: await hashFile(batch) },
      frames,
      cleanup: true,
    });
  }
  report.status = "passed";
  await writeAtomicJson(join(context.output, "source-cache", "report.json"), report);
  return report;
}
