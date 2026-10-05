import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditPrecompositions(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = ledger.reference_baseline.precomposition;
  assert.equal(reference.path, "tests/parity/precomposition-replay/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  const mediaReference = ledger.reference_baseline.precomposition_media;
  assert.equal(
    mediaReference.path,
    "tests/parity/precomposition-replay/reference/media-manifest.json",
  );
  await reader.bytes(mediaReference.path, mediaReference.sha256);
  const mediaFrozen = await reader.json(mediaReference.path);
  assert.equal(mediaFrozen.reference_commit, reference.reference_commit);
  assert.equal(mediaFrozen.profile, "exact");
  assert.equal(mediaFrozen.format, "rgba16float-le");
  assert.equal(mediaFrozen.width, 64);
  assert.equal(mediaFrozen.height, 48);
  assert.deepEqual(mediaFrozen.implementation, frozen.implementation);
  assert.equal(frozen.reference_commit, reference.reference_commit);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.format, "rgba16float-le");
  assert.equal(frozen.width, 64);
  assert.equal(frozen.height, 48);
  await reader.bytes(frozen.implementation.path, frozen.implementation.sha256);
  const output = join(context.output, "precomposition");
  const run = await execute(
    {
      id: "precomposition-gpu",
      file: "node",
      args: ["scripts/migration/precomposition-runner.mjs", output],
      timeout_ms: 300_000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Precomposition GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${path}/gpu.json`);
  assert.equal(gpu.status, "passed");
  const ids = ["direct", "nested", "effects", "generator", "generator-failed", "media"];
  assert.deepEqual(
    gpu.results.map((r) => r.id),
    ids,
  );
  assert.deepEqual(
    frozen.cases.map((r) => r.id),
    ids.slice(0, 5),
  );
  assert.deepEqual(
    mediaFrozen.cases.map((r) => r.id),
    ["media"],
  );
  const messages = await reader.json(`${path}/decoded.json`);
  assert.deepEqual(messages, await reader.json(`${path}/input.json`));
  assert.equal(gpu.rust_messages, messages.length);
  const input = await reader.json(`${path}/replay-input.json`);
  assert.deepEqual(
    input.map((c) => c.id),
    ids,
  );
  const runtime = await loadIrRuntime(context.root);
  try {
    const resources = new Map();
    const expectedRoundtrips = new Set();
    for (const message of messages) {
      const payload = await reader.bytes(`${path}/payloads/${message.hash}.bin`);
      assert.equal(await runtime.contentResourceHash(message, payload.bytes), message.hash);
      resources.set(message.hash, { message, bytes: payload.bytes });
    }
    for (const c of input) {
      for (const name of ["bundle", "warmup"])
        if (c[name]) {
          expectedRoundtrips.add(`${c.id}-${name}`);
          const packet = c[name];
          const bytes = await reader.bytes(`${path}/${c.id}-${name}.decoded.fpln`);
          assert.deepEqual(Buffer.from(packet.plan), bytes.bytes);
          const supplied = packet.resources.map((r) => {
            const checked = resources.get(r.message.hash);
            assert(checked);
            assert.deepEqual(r.message, checked.message);
            assert.deepEqual(Buffer.from(r.bytes), checked.bytes);
            return checked;
          });
          const container = runtime.decodeFramePlan(bytes.bytes);
          const planResources = runtime.precompositionPlanResources(container.metadata.slices[0]);
          assert.deepEqual(packet.plan_resources, planResources);
          for (const hash of planResources) expectedRoundtrips.add(hash);
          const decoded = runtime.readPrecompositionBundle(
            runtime.decodeFramePlan(bytes.bytes),
            supplied,
          );
          if (name === "bundle") {
            const expected = ["nested", "effects", "media"].includes(c.id) ? 2 : 1;
            assert.equal(decoded.plans.length, expected);
            assert.equal(decoded.mediaPixels.length, c.id === "media" ? 1 : 0);
            if (c.id === "media") assert.equal(decoded.mediaPixels[0].pixels.bytes.length, 12288);
            assert.equal(
              decoded.plans.reduce((n, p) => n + p.generators.length, 0),
              c.id.startsWith("generator") ? 1 : 0,
            );
            for (const generator of decoded.plans.flatMap((p) => p.generators)) {
              assert.equal(
                generator.execution?.status,
                c.id === "generator-failed" ? "unavailable" : "ready",
              );
              if (generator.execution.status === "ready") {
                assert(generator.execution.effective_count > 0);
                assert(generator.execution.capacity >= generator.execution.effective_count);
              }
            }
            assert(decoded.graph.bindings.has(c.output));
          } else {
            assert.equal(decoded.plans.length, 1);
            assert(decoded.graph.bindings.has("warmup"));
          }
        }
      assert.equal(Boolean(c.warmup), c.id === "nested");
      const saved = [...frozen.cases, ...mediaFrozen.cases].find((f) => f.id === c.id);
      const expected = await reader.bytes(saved.path, saved.sha256);
      const captured = await reader.bytes(`${path}/${c.id}.reference.bin`);
      const actual = await reader.bytes(`${path}/${c.id}.replay.bin`);
      assert.equal(expected.bytes.length, 24576);
      assert(expected.bytes.some((v) => v !== 0));
      assert.deepEqual(captured.bytes, expected.bytes);
      assert.deepEqual(actual.bytes, expected.bytes);
      const result = gpu.results.find((r) => r.id === c.id);
      for (const field of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[field], true);
      assert.equal(result.bytes, 24576);
      assert.equal(result.pinned, c.id === "nested");
      const mutations = [
        "remove-draw",
        ...(c.id === "nested" ? ["reverse-order"] : []),
        ...(c.id === "effects" ? ["remove-adjustment"] : []),
        ...(c.id === "generator" ? ["remove-generator"] : []),
        ...(c.id === "generator-failed" ? ["restore-generator"] : []),
        ...(c.id === "media" ? ["change-media-pixels"] : []),
      ];
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        mutations,
      );
      for (const m of result.mutations) {
        assert.equal(m.file, `${c.id}.${m.id}.bin`);
        const altered = await reader.bytes(`${path}/${m.file}`);
        assert.equal(altered.bytes.length, 24576);
        let changed = 0;
        for (let i = 0; i < 24576; i += 8)
          if (!altered.bytes.subarray(i, i + 8).equals(expected.bytes.subarray(i, i + 8)))
            changed++;
        assert.equal(changed, m.changed_pixels);
        assert(changed > 16, "Surface mutation must visibly change pixels");
      }
    }
    assert.deepEqual(new Set(gpu.roundtrips), expectedRoundtrips);
    assert.equal(gpu.roundtrips.length, expectedRoundtrips.size);
    assert.equal(gpu.rust_plans, expectedRoundtrips.size);
    for (const id of expectedRoundtrips) {
      const original = await reader.bytes(`${path}/${id}.input.fpln`),
        decoded = await reader.bytes(`${path}/${id}.decoded.fpln`);
      assert.deepEqual(original.bytes, decoded.bytes);
      runtime.decodeFramePlan(decoded.bytes);
      if (resources.has(id)) assert.deepEqual(original.bytes, resources.get(id).bytes);
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
    media_reference: mediaReference,
    rust_plans: gpu.rust_plans,
    rust_messages: gpu.rust_messages,
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
