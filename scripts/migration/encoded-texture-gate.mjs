import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

/** Exact GPU coverage for compressed normal textures absent from the legacy scene corpus. */
export async function auditEncodedTextures(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = ledger.reference_baseline.normal_texture_upload;
  assert.equal(reference.path, "tests/parity/material-textures/legacy-upload.ts");
  await reader.bytes(reference.path, reference.sha256);
  const output = join(context.output, "encoded-textures");
  const run = await execute(
    {
      id: "encoded-textures-gpu",
      file: "node",
      args: ["scripts/migration/encoded-texture-runner.mjs", output],
      timeout_ms: 180_000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Encoded texture GPU execution failed");
  const path = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed");
  assert.deepEqual(
    gpu.results.map((r) => r.encoding),
    ["png", "jpeg", "webp"],
  );
  const messages = await reader.json(`${path}/input.json`);
  assert.deepEqual(await reader.json(`${path}/decoded.json`), messages);
  assert.equal(messages.length, 3);
  const runtime = await loadIrRuntime(context.root);
  try {
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const result = gpu.results[index];
      assert.equal(message.kind, "encoded_texture");
      assert.equal(message.descriptor.encoding, result.encoding);
      assert.equal(message.hash, result.hash);
      assert.equal(result.exact, true);
      assert.equal(result.independent_device, true);
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(payload.bytes.length, result.bytes);
      assert.equal(await runtime.contentResourceHash(message, payload.bytes), message.hash);
      const original = await reader.bytes(`${path}/${result.encoding}.reference.bin`);
      const replay = await reader.bytes(`${path}/${result.encoding}.replay.bin`);
      assert.equal(original.bytes.length, 24);
      assert.deepEqual(replay.bytes, original.bytes);
    }
  } finally {
    await runtime.close();
  }
  return {
    status: "passed",
    profile: "exact",
    results: gpu.results,
    adapter: gpu.adapter,
    reference,
    rust_messages: 3,
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
