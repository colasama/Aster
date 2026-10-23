import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "./source.mjs";

/** A diagnostic warm-up must preserve production frame identities and cooperative cancellation. */
export async function runProjectWarmupLifecycle({ output, cli, run, argumentsFor, report }) {
  const cases = [];
  for (const id of ["minimal-golden", "scene-audio-spectrum-bars"]) {
    const name = `warmup-${id}`,
      args = await argumentsFor(id, name);
    args.push("--benchmark-warmup-frames", "10");
    if (id === "minimal-golden") args.push("--fps-numerator", "30000", "--fps-denominator", "1001");
    const result = await run(name, cli, args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const warmup = result.rows.filter((r) => r.stage === "warmup");
    assert.deepEqual(
      warmup.map((r) => r.rendered_frames),
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    assert(warmup.every((r) => r.total_frames === 10));
    const receipt = result.rows.at(-1),
      witness = JSON.parse(await readFile(receipt.witness.path));
    assert.equal(receipt.report.frames, 12);
    assert.equal(await hashFile(receipt.witness.path), receipt.witness.report_sha256);
    assert.equal(await hashFile(join(output, `${name}.mp4`)), witness.output_sha256);
    const reference =
      id === "minimal-golden"
        ? report.cases.find((c) => c.id === id).witness
        : report.cases.find((c) => c.id === "audio-selection-preserves-reactive-visuals").exports[0]
            .witness;
    assert.equal(witness.frames.length, 4);
    for (const [index, frame] of witness.frames.entries()) {
      const previous = reference.frames[index],
        directory = join(output, `${name}-witness`, String(frame.index));
      assert.equal(frame.time_bits, previous.time_bits);
      assert.equal(frame.rgb.png_sha256, previous.rgb.png_sha256);
      assert.equal(frame.nv12_sha256, previous.nv12_sha256);
      assert.equal(await hashFile(join(directory, "candidate.png")), frame.rgb.png_sha256);
      assert.equal(await hashFile(join(directory, "input.nv12")), frame.nv12_sha256);
    }
    cases.push({ id, receipt, exact_frames: 4, warmup });
  }
  const args = await argumentsFor("minimal-golden", "warmup-cancel");
  args.push("--benchmark-warmup-frames", "10");
  const cancelled = await run("warmup-cancel", cli, args, (row, child) => {
    if (row.stage === "warmup" && row.rendered_frames === 1)
      child.stdin.write('{"action":"cancel"}\n');
  });
  assert.equal(cancelled.code, 2, cancelled.stdout + cancelled.stderr);
  assert(!cancelled.rows.some((r) => r.stage === "audio"));
  assert(!(await readdir(output)).includes("warmup-cancel.mp4"));
  assert(!(await readdir(output)).includes("warmup-cancel-witness"));
  report.controls.push({
    kind: "same-session-warmup",
    cases,
    exact_frames: 8,
    cancelled_without_output: true,
  });
}
