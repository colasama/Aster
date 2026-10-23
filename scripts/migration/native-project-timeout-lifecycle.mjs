import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "./source.mjs";

/** Check optional mux deadlines and failure propagation while the producer is paused. */
export async function runProjectTimeoutLifecycle({ output, cli, run, argumentsFor, report }) {
  for (const [name, seconds] of [
    ["optional-deadline", undefined],
    ["paused-deadline", 3],
    ["zero-deadline", 0],
  ]) {
    const args = await argumentsFor("minimal-golden", name, 100);
    if (seconds !== undefined) args.push("--export-timeout-seconds", String(seconds));
    let requested = false,
      pausedAt,
      resumedAt,
      watchdogFired = false;
    const timers = [];
    const result = await run(name, cli, args, (value, child) => {
      if (seconds !== 0 && value.rendered_frames > 0 && !requested) {
        requested = true;
        child.stdin.write('{"action":"pause","request_id":170}\n');
      }
      if (value.stage === "paused") {
        pausedAt = performance.now();
        if (seconds === undefined)
          timers.push(
            setTimeout(() => {
              resumedAt = performance.now();
              child.stdin.write('{"action":"resume"}\n');
            }, 3500),
          );
        // A failed consumer must release a paused producer without any resume command.
        if (seconds !== undefined)
          timers.push(
            setTimeout(() => {
              watchdogFired = true;
              child.stdin.write('{"action":"cancel"}\n');
            }, 10000),
          );
      }
    });
    timers.forEach(clearTimeout);
    assert(!watchdogFired, "Paused producer failed to observe consumer termination");
    if (seconds !== 0) {
      assert(requested);
      assert.deepEqual(
        result.rows.filter((r) => r.stage === "paused").map((r) => r.request_id),
        [170],
      );
    }
    if (seconds === undefined) {
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert(resumedAt - pausedAt >= 3400);
      const receipt = result.rows.at(-1);
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.report.frames, 100);
      const witness = JSON.parse(await readFile(receipt.witness.path));
      assert.equal(await hashFile(receipt.witness.path), receipt.witness.report_sha256);
      assert.equal(await hashFile(join(output, `${name}.mp4`)), witness.output_sha256);
      const reference = JSON.parse(
        await readFile(join(output, "pause-resume-witness/report.json")),
      );
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
      report.controls.push({
        kind: name,
        pause_ms: resumedAt - pausedAt,
        receipt,
        exact_frames: 4,
      });
    } else {
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        new RegExp(`exceeded its ${seconds * 1000} ms timeout`),
      );
      assert(!resumedAt);
      assert(!(await readdir(output)).includes(`${name}.mp4`));
      assert(!(await readdir(output)).includes(`${name}-witness`));
      report.controls.push({
        kind: name,
        seconds,
        result: result.rows,
        no_resume: true,
        cleanup: true,
      });
    }
  }
}
