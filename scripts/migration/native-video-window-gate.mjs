import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Compare process-batched decode to the single-frame path under seeks and byte pressure. */
export async function runNativeVideoWindowGate(context, options, execute = runStep) {
  const { inputs, receipts: reference, binary, common, reader } = options;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const other = inputs.findIndex((input) => input.source.hash !== inputs[0].source.hash);
  assert(other > 1);
  const indices = [
    0,
    1,
    2,
    1,
    3,
    4,
    5,
    7,
    8,
    9,
    other - 2,
    other - 1,
    other,
    other + 1,
    1,
    2,
    other - 1,
  ];
  const report = { status: "failed", exact_comparisons: 0, modes: [] };
  for (const mode of [
    { id: "single", bytes: 16777216, frames: 1 },
    { id: "window", bytes: 16777216, frames: 8 },
    { id: "window32", bytes: 16777216, frames: 32 },
    { id: "prefetch-off", bytes: 16777216, frames: 32, prefetch: false },
    { id: "source-disabled", bytes: 16777216, frames: 32, snapshotBytes: 0 },
    { id: "source-too-large", bytes: 16777216, frames: 32, snapshotBytes: 1 },
    { id: "window-default", bytes: 16777216, frames: 128, defaultFrames: true },
    { id: "disabled", bytes: 0, frames: 128 },
    { id: "byte-pressure", bytes: inputs[0].asset.width * inputs[0].asset.height * 8, frames: 128 },
  ]) {
    const output = join(context.output, "decode-window", mode.id);
    await mkdir(output, { recursive: true });
    const jobs = indices.map((index, i) => ({
      ...inputs[index].job,
      out: join(output, `${i}.png`),
    }));
    const batch = join(output, "batch.json");
    await writeAtomicJson(batch, jobs);
    const step = await execute(
      {
        id: `video-window-${mode.id}`,
        file: binary,
        args: [
          "render-plan",
          "--batch",
          batch,
          ...common,
          "--media-cache-bytes",
          "0",
          "--video-decode-window-bytes",
          String(mode.bytes),
          ...(mode.prefetch === false ? ["--video-decode-prefetch", "false"] : []),
          ...(mode.snapshotBytes === undefined
            ? []
            : ["--video-snapshot-cache-bytes", String(mode.snapshotBytes)]),
          ...(mode.defaultFrames ? [] : ["--video-decode-window-frames", String(mode.frames)]),
        ],
        timeout_ms: 120000,
      },
      { ...context, output },
    );
    assert.equal(step.status, "passed");
    const receipts = (await readFile(join(context.root, step.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map(JSON.parse);
    assert.equal(receipts.length, jobs.length);
    const prefetch = mode.prefetch !== false && mode.snapshotBytes === undefined;
    let source = null,
      first = 0,
      count = 0,
      processes = 0,
      hits = 0,
      prefetches = 0,
      prefetchHits = 0,
      pending = null;
    const frames = [];
    for (const [i, receipt] of receipts.entries()) {
      const input = inputs[indices[i]],
        expected = reference[indices[i]],
        index = input.frame;
      const image = await reader.image(local(jobs[i].out));
      assert.equal(image.rgba_sha256, expected.rgba_sha256);
      assert.equal(receipt.rgba_sha256, expected.rgba_sha256);
      assert.deepEqual(receipt.native_videos, expected.native_videos);
      assert.deepEqual(receipt.native_images, expected.native_images);
      const size = input.asset.width * input.asset.height * 4;
      const capacity = Math.max(1, Math.min(mode.frames, Math.floor(mode.bytes / size)));
      if (source === input.source.hash && index >= first && index < first + count) hits++;
      else {
        if (
          source === input.source.hash &&
          pending &&
          index >= pending.first &&
          index < pending.first + pending.count
        ) {
          first = pending.first;
          count = pending.count;
          prefetchHits++;
        } else {
          processes++;
          first = index;
          const remaining = input.asset.frameCount - index;
          count =
            prefetch && capacity >= 4 && remaining > capacity
              ? Math.floor(capacity / 2)
              : Math.min(capacity, remaining);
        }
        pending = null;
        if (count === 1) count = 0;
        source = count ? input.source.hash : null;
        const next = first + count;
        if (count && prefetch && capacity >= 4 && next < input.asset.frameCount) {
          const nextCount = Math.min(
            Math.floor(capacity / 2),
            capacity - count,
            input.asset.frameCount - next,
          );
          if (nextCount > 0) {
            pending = { first: next, count: nextCount };
            processes++;
            prefetches++;
          }
        }
      }
      assert.deepEqual(receipt.video_decode_window, {
        processes,
        hits,
        resident_bytes: count * size,
        frames: count,
        prefetches,
        prefetch_hits: prefetchHits,
        pending_bytes: (pending?.count ?? 0) * size,
        pending_frames: pending?.count ?? 0,
      });
      assert((count + (pending?.count ?? 0)) * size <= mode.bytes);
      assert(count + (pending?.count ?? 0) <= mode.frames);
      assert.equal(receipt.media_decode_cache.hits, 0);
      assert(receipt.video_decode_window.resident_bytes <= mode.bytes);
      frames.push({ output: { path: local(jobs[i].out), sha256: image.png_sha256 }, receipt });
    }
    if (mode.id === "window32") assert(prefetchHits > 0);
    if (!prefetch || mode.bytes === 0 || mode.frames === 1) assert.equal(prefetches, 0);
    if (mode.frames > 1 && mode.bytes > 0) assert(hits > 0);
    else assert.equal(processes, indices.length);
    report.exact_comparisons += jobs.length;
    report.modes.push({
      ...mode,
      step,
      request: { path: local(batch), sha256: await hashFile(batch) },
      frames,
    });
  }
  report.status = "passed";
  await writeAtomicJson(join(context.output, "decode-window", "report.json"), report);
  return report;
}
