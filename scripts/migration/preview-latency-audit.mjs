import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";
import { distribution } from "../performance/statistics.mjs";
import { hashFile } from "./source.mjs";

export function validatePreviewLatency(value, composition) {
  assert.equal(value.status, "passed");
  assert.equal(value.scope, "timeline-input-to-compositor-presentation");
  assert.equal(value.warmup, 10);
  assert.equal(value.samples.length, 600, "600 input-to-present samples required");
  assert.deepEqual(value.geometry.quality, {
    antiAliasing: "off",
    memoryBudgetMb: "1024",
    frameCacheBudgetMb: "0",
  });
  assert.equal(value.references.length, 2);
  for (const [index, reference] of value.references.entries()) {
    assert.equal(reference.time, index === 0 ? 24 : 26);
    assert.equal(reference.composition_id, composition);
    assert(/^[a-f0-9]{64}$/.test(reference.image_sha256));
  }
  assert.notEqual(value.references[0].image_sha256, value.references[1].image_sha256);
  let previous = -Infinity;
  for (const [index, sample] of value.samples.entries()) {
    assert.equal(sample.address, index % 2);
    assert.equal(sample.image_sha256, value.references[sample.address].image_sha256);
    assert(Number.isFinite(sample.input_ms) && sample.input_ms > previous);
    assert(Number.isFinite(sample.presentation_ms) && sample.presentation_ms > sample.input_ms);
    assert.equal(sample.latency_ms, sample.presentation_ms - sample.input_ms);
    previous = sample.presentation_ms;
  }
  return distribution(value.samples.map((sample) => sample.latency_ms));
}

/** Re-read original arm reports and frame witnesses; renderer completion alone is inadmissible. */
export async function auditPreviewLatency(root, arms, composition) {
  assert.equal(arms.length, 6, "Three complete latency pairs required");
  const values = { ts: [], native: [] };
  const expected = ["ts", "native", "native", "ts", "ts", "native"];
  const summaries = [];
  for (const [index, arm] of arms.entries()) {
    assert.equal(arm.round, Math.floor(index / 2) + 1);
    assert.equal(arm.engine, expected[index]);
    const path = resolve(root, arm.evidence.path);
    assert.equal(await hashFile(path), arm.evidence.sha256);
    const witness = JSON.parse(await readFile(path, "utf8"));
    assert.equal(witness.status, "passed");
    assert.equal(witness.engine, arm.engine);
    assert.deepEqual(witness.latency, arm.latency);
    assert.deepEqual(
      arm.latency.geometry,
      arms[0].latency.geometry,
      "Latency geometry or quality changed",
    );
    const summary = validatePreviewLatency(arm.latency, composition);
    summaries.push({ round: arm.round, engine: arm.engine, ...summary });
    for (const [address, reference] of arm.latency.references.entries()) {
      const imagePath = join(dirname(path), `latency-reference-${address}.png`);
      assert.equal(resolve(reference.path), imagePath);
      assert.equal(await hashFile(imagePath), reference.png_sha256);
      const image = decodeRgbaPng(await readFile(imagePath));
      // Electron's Windows bitmap witness is BGRA; PNG is independently decoded RGBA.
      const pixels = Buffer.from(image.pixels);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset];
        pixels[offset] = pixels[offset + 2];
        pixels[offset + 2] = red;
      }
      assert.equal(createHash("sha256").update(pixels).digest("hex"), reference.image_sha256);
    }
    if (arm.engine === "native")
      for (const reference of arm.latency.references)
        assert(
          witness.native_calls.some(
            (call) =>
              call.channel === "aster:native-preview-present" && call.time === reference.time,
          ),
        );
    else assert.equal(witness.native_calls.length, 0);
    values[arm.engine].push(...arm.latency.samples.map((sample) => sample.latency_ms));
  }
  const ts = distribution(values.ts),
    native = distribution(values.native);
  return {
    status: native.p95 <= ts.p95 ? "passed" : "failed",
    ts,
    native,
    runs: summaries,
    criterion: "Native input-to-compositor-presentation p95 must not exceed contemporaneous TS",
  };
}
