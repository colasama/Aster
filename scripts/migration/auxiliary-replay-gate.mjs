import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditAuxiliaryReplay(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json"),
    reference = ledger.reference_baseline.auxiliary;
  assert.equal(reference.path, "tests/parity/auxiliary-replay/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.reference_commit, reference.reference_commit);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.width, 64);
  assert.equal(frozen.height, 48);
  await reader.bytes(frozen.implementation.path, frozen.implementation.sha256);
  const ids = ["basic", "tier0", "tier1", "tier2", "no-motion", "cleared"];
  assert.deepEqual(
    frozen.cases.map((c) => c.id),
    ids,
  );
  const output = join(context.output, "auxiliary");
  const run = await execute(
    {
      id: "auxiliary-gpu",
      file: "node",
      args: ["scripts/migration/auxiliary-replay-runner.mjs", output],
      timeout_ms: 120000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Supplied auxiliary GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/"),
    gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed", gpu.error);
  assert.equal(gpu.rust_plans, 13);
  assert.equal(gpu.rust_messages, 3);
  assert.deepEqual(
    gpu.results.map((c) => c.id),
    ids,
  );
  const messages = await reader.json(`${path}/decoded.json`);
  assert.deepEqual(messages, await reader.json(`${path}/input.json`));
  assert.equal(messages.length, 3);
  const inputs = await reader.json(`${path}/replay-input.json`);
  assert.deepEqual(
    inputs.map((c) => c.id),
    ids,
  );
  const runtime = await loadIrRuntime(context.root),
    expectedPlans = [];
  try {
    for (const message of messages) {
      runtime.validateResourceMessage(message);
      const pixels = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(runtime.contentResourceHashSync(message, pixels.bytes), message.hash);
    }
    for (const [index, c] of frozen.cases.entries()) {
      const result = gpu.results[index],
        input = inputs[index];
      assert.equal(result.tier, c.tier);
      assert.equal(input.tier, c.tier);
      assert.deepEqual(result.targets, c.targets);
      assert.equal(result.bytes, c.bytes);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      const expected = await reader.bytes(c.path, c.sha256),
        legacy = await reader.bytes(`${path}/${c.id}.reference.bin`),
        actual = await reader.bytes(`${path}/${c.id}.replay.bin`);
      assert.equal(expected.bytes.length, c.bytes);
      assert.deepEqual(legacy.bytes, expected.bytes);
      assert.deepEqual(actual.bytes, expected.bytes);
      const names = ["scene", "auxiliary", ...(c.id === "cleared" ? ["prime"] : [])];
      for (const name of names) {
        const id = `${c.id}-${name}`;
        expectedPlans.push(id);
        const a = await reader.bytes(`${path}/${id}.input.fpln`),
          b = await reader.bytes(`${path}/${id}.decoded.fpln`);
        assert.deepEqual(a.bytes, b.bytes);
        assert.deepEqual(b.bytes, Buffer.from(input[name]));
        runtime.decodeFramePlan(b.bytes);
      }
      const plan = runtime.readAuxiliaryPlan(
        runtime.decodeFramePlan(new Uint8Array(input.auxiliary)),
      );
      assert.equal(plan.slice.tier, c.tier);
      assert.equal(plan.slice.status, c.id === "cleared" ? "cleared" : "drawn");
      assert.equal(plan.slice.motion, !["cleared", "no-motion"].includes(c.id));
      assert.equal(input.resources.length, 3);
      for (const r of input.resources) {
        const message = messages.find((m) => m.hash === r.message.hash);
        assert.deepEqual(r.message, message);
        const bytes = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
        assert.deepEqual(Buffer.from(r.pixels), bytes.bytes);
      }
      const mutations =
        c.id === "cleared"
          ? ["skip-clear"]
          : [
              "change-id",
              "remove-draw",
              ...(c.id === "no-motion" ? [] : ["remove-motion"]),
              "remove-texture",
              ...(c.tier >= 1 ? ["remove-transparency"] : []),
            ];
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        mutations,
      );
      for (const m of result.mutations) {
        assert.equal(m.file, `${c.id}.${m.id}.bin`);
        const altered = await reader.bytes(`${path}/${m.file}`);
        assert.equal(altered.bytes.length, c.bytes);
        let changed = 0,
          offset = 0;
        for (const target of c.targets) {
          assert.equal(target.bytes, 64 * 48 * target.bpp);
          for (let i = 0; i < target.bytes; i += target.bpp)
            if (
              !altered.bytes
                .subarray(offset + i, offset + i + target.bpp)
                .equals(expected.bytes.subarray(offset + i, offset + i + target.bpp))
            )
              changed++;
          offset += target.bytes;
        }
        assert.equal(offset, c.bytes);
        assert.equal(changed, m.changed_pixels);
        assert(changed > 16);
      }
    }
    assert.deepEqual(gpu.roundtrips, expectedPlans);
  } finally {
    await runtime.close();
  }
  return {
    status: "passed",
    profile: "exact",
    reference,
    adapter: gpu.adapter,
    results: gpu.results,
    rust_plans: gpu.rust_plans,
    rust_messages: gpu.rust_messages,
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
