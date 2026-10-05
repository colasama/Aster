import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditRootScenes(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = ledger.reference_baseline.root_scene;
  assert.equal(reference.path, "tests/parity/root-scene/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.reference_commit, reference.reference_commit);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.format, "rgba16float-le");
  assert.equal(frozen.width, 64);
  assert.equal(frozen.height, 48);
  await reader.bytes(frozen.implementation.path, frozen.implementation.sha256);
  const output = join(context.output, "root-scene");
  const run = await execute(
    {
      id: "root-scene-gpu",
      file: "node",
      args: ["scripts/migration/root-scene-runner.mjs", output],
      timeout_ms: 180_000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Root scene GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed");
  assert.equal(gpu.rust_plans, 12);
  assert.equal(gpu.rust_messages, 1);
  const ids = ["direct", "depth", "isolated", "adjustment"];
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
  assert.equal(messages.length, 1);
  const runtime = await loadIrRuntime(context.root);
  try {
    for (const message of messages) {
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(await runtime.contentResourceHash(message, payload.bytes), message.hash);
    }
    const hashes = new Set();
    for (const id of ids) {
      const planIds = [
        `${id}-scene`,
        `${id}-root`,
        ...(["isolated", "adjustment"].includes(id) ? [`${id}-effect-0`, `${id}-execution-0`] : []),
      ];
      for (const planId of planIds) {
        const original = await reader.bytes(`${path}/${planId}.input.fpln`);
        const decoded = await reader.bytes(`${path}/${planId}.decoded.fpln`);
        assert.deepEqual(decoded.bytes, original.bytes);
        const plan = runtime.decodeFramePlan(decoded.bytes);
        if (planId.endsWith("-scene"))
          assert.equal(runtime.prepareSceneBuffers(plan).draws.length, 3);
        if (planId.endsWith("-root"))
          assert.equal(plan.metadata.contract_level, "root_scene_commands_slice_v1");
      }
      const saved = frozen.cases.find((c) => c.id === id);
      const expected = await reader.bytes(saved.path, saved.sha256);
      const captured = await reader.bytes(`${path}/${id}.reference.bin`);
      const replay = await reader.bytes(`${path}/${id}.replay.bin`);
      assert.equal(expected.bytes.length, 24576);
      assert.deepEqual(captured.bytes, expected.bytes);
      assert.deepEqual(replay.bytes, expected.bytes);
      hashes.add(saved.sha256);
      const result = gpu.results.find((r) => r.id === id);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      assert.equal(result.bytes, 24576);
      assert.deepEqual(result.metrics, saved.metrics);
      const mutationIds = [
        "remove-draw",
        ...(id === "direct"
          ? ["reorder-draws"]
          : id === "depth"
            ? ["retain-depth"]
            : id === "adjustment"
              ? ["remove-adjustment"]
              : []),
      ];
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        mutationIds,
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
        assert(changed > 16, "Supplied command mutation must visibly change GPU output");
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
