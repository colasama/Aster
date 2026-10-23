import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeRgbaPng } from "../parity/png.mjs";
import { hashFile } from "./source.mjs";

export async function runProjectImageLifecycle({ output, cli, run, argumentsFor, report }) {
  async function imageArguments(id, name, format, count = 12, odd = false) {
    const args = await argumentsFor(id, name, count);
    for (const flag of ["--witness", "--witness-frames"]) args.splice(args.indexOf(flag), 2);
    args[args.indexOf("--out") + 1] = join(output, name);
    args.push("--format", format);
    if (odd) {
      args[args.indexOf("--width") + 1] = "321";
      args[args.indexOf("--height") + 1] = "181";
      args[args.indexOf("--start-frame") + 1] = "3";
      args.push("--fps-numerator", "30000", "--fps-denominator", "1001");
    }
    return args;
  }
  async function validate(name, result, count, size) {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const receipt = result.rows.at(-1);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.report.frames, count);
    assert.equal(receipt.images.length, count);
    assert.deepEqual(receipt.size, size);
    const decoded = [];
    for (const [index, frame] of receipt.images.entries()) {
      assert.equal(frame.index, index);
      const path = receipt.format === "png" ? join(output, name) : join(output, name, frame.member);
      assert.equal(await hashFile(path), frame.png_sha256);
      const bytes = await readFile(path),
        image = decodeRgbaPng(bytes);
      assert.equal(bytes.length, frame.bytes);
      assert.equal(image.width, size.width);
      assert.equal(image.height, size.height);
      assert.equal(createHash("sha256").update(image.pixels).digest("hex"), frame.rgba_sha256);
      const expectedTime =
        ((3 + index) * receipt.frame_rate.denominator) / receipt.frame_rate.numerator;
      assert.equal(frame.time, expectedTime);
      const bits = Buffer.alloc(8);
      bits.writeDoubleBE(expectedTime);
      assert.equal(frame.time_bits, bits.toString("hex"));
      decoded.push(image);
    }
    if (receipt.format === "png-sequence")
      assert.deepEqual(
        (await readdir(join(output, name))).sort(),
        receipt.images.map((f) => f.member).sort(),
      );
    return { receipt, decoded };
  }
  const sequenceArgs = await imageArguments(
    "scene-audio-spectrum-bars",
    "spectrum-sequence",
    "png-sequence",
  );
  const sequence = await validate(
    "spectrum-sequence",
    await run("spectrum-sequence", cli, sequenceArgs),
    12,
    { width: 320, height: 180 },
  );
  const reference = report.cases.find((c) => c.id === "audio-selection-preserves-reactive-visuals")
    .exports[0].witness;
  assert.equal(sequence.receipt.project.authored_sha256, reference.project_authored_sha256);
  for (const frame of reference.frames) {
    assert.equal(sequence.receipt.images[frame.index].rgba_sha256, frame.rgb.rgba_sha256);
    assert.equal(sequence.receipt.images[frame.index].time_bits, frame.time_bits);
  }
  const oddArgs = await imageArguments("layer-text", "odd-sequence", "png-sequence", 3, true);
  let pauseObservation, pauseError;
  const oddResult = await run("odd-sequence", cli, oddArgs, (row, child, rows) => {
    if (row.rendered_frames === 1) child.stdin.write('{"action":"pause","request_id":5}\n');
    if (row.stage === "paused") {
      pauseObservation = (async () => {
        assert.equal(row.request_id, 5);
        const count = rows.filter((r) => r.rendered_frames > 0).length;
        await delay(200);
        assert.equal(rows.filter((r) => r.rendered_frames > 0).length, count);
        child.stdin.write('{"action":"resume"}\n');
        return { request_id: 5, settled_frames: count, pause_observation_ms: 200 };
      })().catch((error) => {
        pauseError = error;
        child.stdin.write('{"action":"cancel"}\n');
      });
    }
  });
  assert(pauseObservation);
  await pauseObservation;
  if (pauseError) throw pauseError;
  const odd = await validate("odd-sequence", oddResult, 3, { width: 321, height: 181 });
  assert(
    odd.decoded[0].pixels.some((value, index) => index % 4 === 3 && value < 255),
    "PNG alpha was made opaque",
  );
  const stillArgs = await imageArguments("layer-text", "odd-still.png", "png", 1, true);
  stillArgs.splice(stillArgs.indexOf("--frames"), 2);
  const still = await validate("odd-still.png", await run("odd-still", cli, stillArgs), 1, {
    width: 321,
    height: 181,
  });
  assert.equal(still.receipt.images[0].rgba_sha256, odd.receipt.images[0].rgba_sha256);
  const prior = await hashFile(join(output, "odd-still.png"));
  const existing = await run("png-existing", cli, stillArgs);
  assert.equal(existing.code, 2);
  assert.equal(await hashFile(join(output, "odd-still.png")), prior);
  for (const mode of ["cancel", "budget", "count"]) {
    const name = `png-failed-${mode}`;
    const args = await imageArguments(
      "layer-text",
      name,
      mode === "count" ? "png" : "png-sequence",
      mode === "cancel" ? 60 : 2,
    );
    if (mode === "budget") args.push("--image-output-bytes", "1");
    const result = await run(name, cli, args, (row, child) => {
      if (mode === "cancel" && row.rendered_frames === 1)
        child.stdin.write('{"action":"pause","request_id":6}\n');
      if (row.stage === "paused") child.stdin.write('{"action":"cancel"}\n');
    });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    if (mode === "cancel")
      assert(result.rows.some((r) => r.stage === "paused" && r.request_id === 6));
    assert(!(await readdir(output)).includes(name));
    report.controls.push({ kind: name, result: result.rows });
  }
  assert(!(await readdir(output)).some((n) => n.startsWith(".aster-png-")));
  report.cases.push({
    id: "native-png-outputs",
    sequence: sequence.receipt,
    odd_sequence: odd.receipt,
    still: still.receipt,
    pause: await pauseObservation,
    video_rgb_exact_frames: reference.frames.map((f) => f.index),
  });
}
