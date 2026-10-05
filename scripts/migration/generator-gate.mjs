import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditGenerators(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = ledger.reference_baseline.generator_draw;
  assert.equal(reference.path, "tests/parity/generators-replay/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.reference_commit, reference.reference_commit);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.format, "rgba16float-le");
  assert.equal(frozen.width, 128);
  assert.equal(frozen.height, 96);
  await reader.bytes(frozen.implementation.path, frozen.implementation.sha256);
  const output = join(context.output, "generators");
  const run = await execute(
    {
      id: "generators-gpu",
      file: "node",
      args: ["scripts/migration/generator-runner.mjs", output],
      timeout_ms: 180000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Generator GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed");
  assert.equal(gpu.rust_plans, 8);
  assert.equal(gpu.rust_messages, 4);
  const ids = ["billboard", "streak", "mesh", "clones", "audio-bars", "audio-ring", "audio-scope"];
  assert.deepEqual(
    gpu.results.map((r) => r.id),
    ids,
  );
  assert.deepEqual(
    frozen.cases.map((r) => r.id),
    ids,
  );
  const messages = await reader.json(`${path}/decoded.json`);
  assert.deepEqual(messages, await reader.json(`${path}/input.json`));
  assert.equal(messages.length, 4);
  const runtime = await loadIrRuntime(context.root);
  try {
    const resources = new Map();
    for (const message of messages) {
      assert.equal(message.kind, "buffer");
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(await runtime.contentResourceHash(message, payload.bytes), message.hash);
      resources.set(message.hash, { message, bytes: new Uint8Array(payload.bytes) });
    }
    const hashes = new Set();
    for (const id of ids) {
      const audio = id.startsWith("audio-");
      const instanceIds = new Set();
      for (let i = 0; i < (id === "clones" ? 2 : 1); i++) {
        const original = await reader.bytes(`${path}/${id}-${i}.input.fpln`),
          decoded = await reader.bytes(`${path}/${id}-${i}.decoded.fpln`);
        assert.deepEqual(decoded.bytes, original.bytes);
        const slice = runtime.decodeFramePlan(decoded.bytes);
        assert.equal(slice.metadata.contract_level, "scene_generator_slice_v1");
        const plan = runtime.readGeneratorSlice(slice, resources);
        runtime.validateGeneratorResources(plan);
        assert.equal(plan.effectiveCount, audio ? 48 : 257);
        const context = new DataView(
          plan.context.buffer,
          plan.context.byteOffset,
          plan.context.byteLength,
        );
        assert.equal(context.getFloat32(8, true), 1.5);
        assert.equal(context.getFloat32(12, true), 1);
        assert.equal(plan.audio !== undefined, audio);
        if (audio) {
          assert.equal(
            new DataView(plan.audio.buffer, plan.audio.byteOffset).getFloat32(16, true),
            Math.fround(1.1),
          );
          assert(plan.audio.subarray(64).some((v) => v !== 0));
        }
        instanceIds.add(plan.instanceId);
      }
      assert.equal(instanceIds.size, id === "clones" ? 2 : 1);
      const saved = frozen.cases.find((c) => c.id === id);
      const expected = await reader.bytes(saved.path, saved.sha256),
        captured = await reader.bytes(`${path}/${id}.reference.bin`),
        replay = await reader.bytes(`${path}/${id}.replay.bin`);
      assert.equal(expected.bytes.length, 98304);
      assert(expected.bytes.some((v) => v !== 0));
      assert.deepEqual(captured.bytes, expected.bytes);
      assert.deepEqual(replay.bytes, expected.bytes);
      hashes.add(saved.sha256);
      const result = gpu.results.find((r) => r.id === id);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      assert.equal(result.bytes, 98304);
      assert.deepEqual(result.counts, saved.counts);
      const mutations = [
        "skip-compute",
        audio ? "silent-audio" : "zero-opacity",
        ...(id === "clones" ? ["remove-clone"] : []),
      ];
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        mutations,
      );
      for (const m of result.mutations) {
        assert.equal(m.file, `${id}.${m.id}.bin`);
        const modified = await reader.bytes(`${path}/${m.file}`);
        assert.equal(modified.bytes.length, expected.bytes.length);
        let changed = 0;
        for (let i = 0; i < modified.bytes.length; i += 8)
          if (!modified.bytes.subarray(i, i + 8).equals(expected.bytes.subarray(i, i + 8)))
            changed++;
        assert.equal(changed, m.changed_pixels);
        assert(changed > 16, "Supplied generator mutation must visibly change pixels");
      }
    }
    assert.equal(hashes.size, ids.length);
  } finally {
    await runtime.close();
  }
  return {
    status: "passed",
    profile: "exact",
    results: gpu.results,
    adapter: gpu.adapter,
    reference,
    rust_plans: gpu.rust_plans,
    rust_messages: gpu.rust_messages,
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
