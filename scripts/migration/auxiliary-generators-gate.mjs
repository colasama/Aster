import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditAuxiliaryGenerators(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json"),
    reference = ledger.reference_baseline.auxiliary_generators;
  assert.equal(reference.path, "tests/parity/auxiliary-generators/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.width, 128);
  assert.equal(frozen.height, 96);
  assert.deepEqual(frozen.reference_commits, reference.reference_commits);
  assert.deepEqual(
    frozen.implementations.map((i) => i.path),
    [
      "tests/parity/auxiliary-replay/legacy-auxiliary.ts",
      "tests/parity/generators-replay/legacy-host.ts",
    ],
  );
  for (const implementation of frozen.implementations)
    await reader.bytes(implementation.path, implementation.sha256);
  const ids = ["billboard", "streak", "mesh", "clones", "audio-bars"];
  assert.deepEqual(
    frozen.cases.map((c) => c.id),
    ids,
  );
  const output = join(context.output, "auxiliary-generators"),
    run = await execute(
      {
        id: "auxiliary-generators-gpu",
        file: "node",
        args: ["scripts/migration/auxiliary-generators-runner.mjs", output],
        timeout_ms: 120000,
      },
      context,
    );
  assert.equal(run.status, "passed", "Auxiliary generator GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/"),
    gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed", gpu.error);
  assert.equal(gpu.rust_plans, 11);
  assert.equal(gpu.rust_messages, 4);
  assert.deepEqual(
    gpu.results.map((r) => r.id),
    ids,
  );
  const messages = await reader.json(`${path}/decoded.json`);
  assert.deepEqual(messages, await reader.json(`${path}/input.json`));
  assert.equal(messages.length, 4);
  const input = await reader.json(`${path}/replay-input.json`);
  assert.deepEqual(
    input.cases.map((c) => c.id),
    ids,
  );
  assert.equal(input.resources.length, messages.length);
  const runtime = await loadIrRuntime(context.root),
    roundtrips = [];
  try {
    const resources = new Map();
    for (const [i, message] of messages.entries()) {
      assert.equal(message.kind, "buffer");
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(runtime.contentResourceHashSync(message, payload.bytes), message.hash);
      assert.deepEqual(input.resources[i].message, message);
      assert.deepEqual(Buffer.from(input.resources[i].bytes), payload.bytes);
      resources.set(message.hash, { message, bytes: new Uint8Array(payload.bytes) });
    }
    for (const [i, c] of frozen.cases.entries()) {
      const supplied = input.cases[i],
        result = gpu.results[i],
        audio = c.id === "audio-bars",
        count = c.id === "clones" ? 2 : 1;
      assert.equal(supplied.plans.length, count);
      assert.equal(result.bytes, 344064);
      assert.equal(result.auxiliary_count, audio ? 0 : count);
      assert.equal(result.missing_auxiliary_rejected, audio);
      assert.deepEqual(result.counts, Array(count).fill(audio ? 48 : 257));
      assert.deepEqual(result.targets, c.targets);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      const comparePlan = async (id, bytes) => {
        roundtrips.push(id);
        const a = await reader.bytes(`${path}/${id}.input.fpln`),
          b = await reader.bytes(`${path}/${id}.decoded.fpln`);
        assert.deepEqual(a.bytes, b.bytes);
        assert.deepEqual(b.bytes, Buffer.from(bytes));
        return runtime.decodeFramePlan(b.bytes);
      };
      const auxiliary = runtime.readAuxiliaryPlan(
        await comparePlan(`${c.id}-auxiliary`, supplied.auxiliary),
      );
      assert.equal(auxiliary.slice.tier, -1);
      assert.equal(auxiliary.slice.status, "drawn");
      assert.equal(auxiliary.slice.vertex_count, 0);
      assert.equal(auxiliary.slice.draws.length, 0);
      assert.equal(auxiliary.slice.motion, false);
      const expectedIds = [];
      for (const [index, bytes] of supplied.plans.entries()) {
        const slice = await comparePlan(`${c.id}-generator-${index}`, bytes);
        assert.deepEqual(slice.metadata.header, auxiliary.header);
        const plan = runtime.readGeneratorSlice(slice, resources);
        assert.equal(plan.effectiveCount, audio ? 48 : 257);
        assert.equal(plan.audio !== undefined, audio);
        const hasAuxiliary =
          plan.program.graph.render_variants[plan.variantIndex].auxiliary !== undefined;
        assert.equal(hasAuxiliary, !audio);
        if (hasAuxiliary) expectedIds.push(plan.instanceId);
      }
      assert.deepEqual(
        auxiliary.slice.generators.map(runtime.compositionIdentityToString),
        expectedIds,
      );
      const expected = await reader.bytes(c.path, c.sha256),
        legacy = await reader.bytes(`${path}/${c.id}.reference.bin`),
        actual = await reader.bytes(`${path}/${c.id}.replay.bin`);
      assert.equal(expected.bytes.length, 344064);
      assert.deepEqual(legacy.bytes, expected.bytes);
      assert.deepEqual(actual.bytes, expected.bytes);
      assert.equal(
        expected.bytes.every((v) => v === 0),
        audio,
      );
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        audio ? [] : ["skip-compute", "remove-generator", "change-ids"],
      );
      for (const m of result.mutations) {
        assert.equal(m.file, `${c.id}.${m.id}.bin`);
        const altered = await reader.bytes(`${path}/${m.file}`);
        assert.equal(altered.bytes.length, 344064);
        let offset = 0,
          changed = 0;
        for (const target of c.targets) {
          assert.equal(target.bytes, 128 * 96 * target.bpp);
          for (let j = 0; j < target.bytes; j += target.bpp)
            if (
              !altered.bytes
                .subarray(offset + j, offset + j + target.bpp)
                .equals(expected.bytes.subarray(offset + j, offset + j + target.bpp))
            )
              changed++;
          offset += target.bytes;
        }
        assert.equal(offset, 344064);
        assert.equal(changed, m.changed_pixels);
        assert(changed > 16);
      }
    }
    assert.deepEqual(gpu.roundtrips, roundtrips);
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
