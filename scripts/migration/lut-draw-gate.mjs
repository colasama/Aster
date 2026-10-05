import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditLutDraws(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = ledger.reference_baseline.lut_draw;
  assert.equal(reference.path, "tests/parity/lut-draw/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.reference_commit, reference.reference_commit);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.format, "rgba16float-le");
  assert.equal(frozen.width, 64);
  assert.equal(frozen.height, 48);
  await reader.bytes(frozen.implementation.path, frozen.implementation.sha256);
  const output = join(context.output, "lut-draw");
  const run = await execute(
    {
      id: "lut-draw-gpu",
      file: "node",
      args: ["scripts/migration/lut-draw-runner.mjs", output],
      timeout_ms: 180_000,
    },
    context,
  );
  assert.equal(run.status, "passed", "LUT draw replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed");
  const ids = ["identity", "custom", "adjustment", "blur", "glow", "blend"];
  assert.deepEqual(
    gpu.results.map((r) => r.id),
    ids,
  );
  assert.deepEqual(
    frozen.cases.map((r) => r.id),
    ids,
  );
  const messages = await reader.json(`${path}/input.json`);
  assert.equal(messages.length, 3);
  assert.deepEqual(await reader.json(`${path}/decoded.json`), messages);
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["texture_pixels", "texture_pixels", "texture_pixels"],
  );
  const runtime = await loadIrRuntime(context.root);
  const pixelHashes = new Set();
  try {
    for (const message of messages) {
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(await runtime.contentResourceHash(message, payload.bytes), message.hash);
    }
    for (const id of ids) {
      const original = await reader.bytes(`${path}/${id}.input.fpln`);
      const decoded = await reader.bytes(`${path}/${id}.decoded.fpln`);
      assert.deepEqual(decoded.bytes, original.bytes);
      const plan = runtime.decodeFramePlan(decoded.bytes);
      const effect = runtime.readLayerEffectSlice(plan);
      const lut = messages.find((m) => m.hash === effect.slice.lut_hash);
      assert.equal(lut?.descriptor.dimension, "3d");
      assert.equal(effect.slice.route, id === "adjustment" ? "adjustment" : "layer");
      assert.equal(effect.slice.uses_blur, id === "blur");
      assert.equal(effect.slice.uses_glow, id === "glow");
      assert.equal(effect.slice.blend_mode, id === "blend" ? "soft-light" : "normal");
      const saved = frozen.cases.find((c) => c.id === id);
      const expected = await reader.bytes(saved.path, saved.sha256);
      const captured = await reader.bytes(`${path}/${id}.reference.bin`);
      const replay = await reader.bytes(`${path}/${id}.replay.bin`);
      assert.equal(expected.bytes.length, 64 * 48 * 8);
      let covered = 0;
      for (let offset = 6; offset < expected.bytes.length; offset += 8)
        if (expected.bytes[offset] || expected.bytes[offset + 1]) covered++;
      assert.equal(covered, saved.covered_pixels);
      assert(covered > 100, "LUT fixture must draw visible geometry");
      assert.deepEqual(captured.bytes, expected.bytes);
      assert.deepEqual(replay.bytes, expected.bytes);
      pixelHashes.add(saved.sha256);
      const result = gpu.results.find((r) => r.id === id);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      assert.equal(result.bytes, expected.bytes.length);
    }
    assert.equal(pixelHashes.size, ids.length);
  } finally {
    await runtime.close();
  }
  return {
    status: "passed",
    profile: "exact",
    results: gpu.results,
    adapter: gpu.adapter,
    reference,
    rust_plans: 6,
    rust_messages: 3,
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
