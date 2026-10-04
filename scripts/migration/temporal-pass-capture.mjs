import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateCapturedRaster } from "../parity/raster-capture.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function captureTemporalPassReplay(config, window, result, payloads) {
  const input = join(config.output, `${result.mode}-ts.fpln`);
  const output = join(config.output, `${result.mode}-rust.fpln`);
  await writeFile(input, Buffer.from(result.pass), { flag: "wx" });
  const roundtrip = await runStep(
    {
      id: `pass-${result.mode}`,
      file: join(
        config.root,
        "target",
        "release",
        `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
      ),
      args: ["ir", "roundtrip", "--input", input, "--output", output],
      timeout_ms: 30000,
    },
    { root: config.root, output: config.output, env: process.env },
  );
  assert.equal(roundtrip.status, "passed", "Rust temporal pass roundtrip failed");
  const supplied = await readFile(output);
  assert(supplied.equals(Buffer.from(result.pass)), "Rust temporal pass bytes differ");
  const records = [];
  for (const sample of result.sample_resources) {
    const pixels = Buffer.from(sample.pixels);
    const replay = Buffer.from(sample.replay);
    const record = validateCapturedRaster(sample.messages, pixels, replay);
    await writeFile(join(payloads, `${record.pixel_hash}.bin`), pixels, { flag: "wx" });
    await writeFile(join(payloads, `${record.pixel_hash}.replay.bin`), replay, { flag: "wx" });
    await writeAtomicJson(join(payloads, `${record.pixel_hash}.json`), sample.messages);
    records.push(record);
  }
  const inputData = {
    pass: Array.from(supplied),
    output: result.messages.slice(0, 2),
    samples: result.sample_resources.map((sample) => ({
      messages: sample.messages,
      pixels: sample.pixels,
    })),
  };
  const replay = Buffer.from(
    await window.webContents.executeJavaScript(
      `window.replayTemporalPass(${JSON.stringify(inputData)})`,
    ),
  );
  assert(replay.equals(Buffer.from(result.pixels)), "Decoded temporal pass GPU output differs");
  await writeFile(join(config.output, `${result.mode}-pass-replay.bin`), replay, { flag: "wx" });
  return {
    mode: result.mode,
    samples: records,
    plan_sha256: sha(supplied),
    replay_sha256: sha(replay),
    exact: true,
    rust_roundtrip: true,
    independent_device: true,
    output_bytes: replay.length,
  };
}

export async function auditTemporalPassReplay(
  reader,
  logical,
  runtime,
  record,
  output,
  pixels,
  transcript,
) {
  const input = await reader.bytes(`${logical}/${record.mode}-ts.fpln`, record.plan_sha256);
  const returned = await reader.bytes(`${logical}/${record.mode}-rust.fpln`, record.plan_sha256);
  assert(input.bytes.equals(returned.bytes));
  const decoded = runtime.decodeFramePlan(returned.bytes);
  const plan = runtime.readTemporalPassSlice(decoded);
  assert.equal(decoded.metadata.header.snapshot_scope, "temporal-gpu");
  assert.equal(plan.output, output.frame_hash);
  assert.equal(plan.width, output.width);
  assert.equal(plan.height, output.height);
  assert.equal(record.samples.length, plan.samples.length);
  assert.equal(record.samples.length, output.samples);
  for (let index = 0; index < record.samples.length; index++) {
    const sample = record.samples[index];
    assert(/^[a-f0-9]{64}$/.test(sample.pixel_hash));
    const prefix = `${logical}/payloads/${sample.pixel_hash}`;
    const raw = await reader.bytes(`${prefix}.bin`, sample.pixels_sha256);
    const replay = await reader.bytes(`${prefix}.replay.bin`, sample.replay_sha256);
    const messages = await reader.json(`${prefix}.json`);
    assert.deepEqual(validateCapturedRaster(messages, raw.bytes, replay.bytes), sample);
    assert.equal(sample.frame_hash, plan.samples[index].hash);
    assert.equal(messages[0].descriptor.authorization_scope, "temporal-gpu");
    assert.equal(messages[1].descriptor.width, plan.width);
    assert.equal(messages[1].descriptor.height, plan.height);
    transcript.push(...messages);
  }
  const replay = await reader.bytes(
    `${logical}/${record.mode}-pass-replay.bin`,
    record.replay_sha256,
  );
  assert(
    replay.bytes.equals(pixels.bytes),
    "Decoded temporal pass output differs from frozen pixels",
  );
  assert.equal(record.output_bytes, replay.bytes.length);
  for (const key of ["exact", "rust_roundtrip", "independent_device"])
    assert.equal(record[key], true);
}
