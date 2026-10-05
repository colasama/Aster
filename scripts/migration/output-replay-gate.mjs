import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";

export async function auditOutputReplay(reader, context, execute) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json"),
    reference = ledger.reference_baseline.output_replay;
  assert.equal(reference.path, "tests/parity/output-replay/reference/manifest.json");
  await reader.bytes(reference.path, reference.sha256);
  const frozen = await reader.json(reference.path);
  assert.equal(frozen.profile, "exact");
  assert.equal(frozen.cases.length, 23);
  for (const i of frozen.implementations) await reader.bytes(i.path, i.sha256);
  const output = join(context.output, "output-replay"),
    run = await execute(
      {
        id: "output-gpu",
        file: "node",
        args: ["scripts/migration/output-replay-runner.mjs", output],
        timeout_ms: 120000,
      },
      context,
    );
  assert.equal(run.status, "passed", "Combined output GPU replay failed");
  const path = relative(context.root, output).replaceAll("\\", "/"),
    gpu = await reader.json(`${path}/gpu.json`),
    inputs = await reader.json(`${path}/replay-input.json`);
  assert.equal(gpu.status, "passed", gpu.error);
  assert.equal(gpu.rust_plans, 56);
  const ids = [
    "beauty",
    "linearColor",
    "luminance",
    "alpha",
    "normal",
    "objectId",
    "materialId",
    "worldPosition",
    "motionVector",
    "depthFog",
    "depthOfField",
    "selectionIsolation",
    "vectorMotionBlur",
    ...["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) => [
      `motion-beauty-${aa}`,
      `motion-depthOfField-${aa}`,
    ]),
    "depth-tier0",
    "depth-tier1",
  ];
  for (const list of [frozen.cases, gpu.results, inputs])
    assert.deepEqual(
      list.map((c) => c.id),
      ids,
    );
  const hash = (b) => createHash("sha256").update(b).digest("hex"),
    runtime = await loadIrRuntime(context.root),
    roundtrips = [];
  try {
    for (const [index, c] of frozen.cases.entries()) {
      const result = gpu.results[index],
        input = inputs[index];
      assert.equal(hash(JSON.stringify(input)), c.input_sha256);
      for (const key of ["exact", "independent_device", "rust_roundtrip"])
        assert.equal(result[key], true);
      assert.equal(result.bytes, 64 * 48 * 4);
      const expected = await reader.bytes(c.path, c.sha256),
        legacy = await reader.bytes(`${path}/${c.id}.reference.bin`),
        actual = await reader.bytes(`${path}/${c.id}.replay.bin`);
      assert.deepEqual(legacy.bytes, expected.bytes);
      assert.deepEqual(actual.bytes, expected.bytes);
      assert.equal(actual.bytes.length, result.bytes);
      const plans = {};
      for (const [name, bytes] of Object.entries(input.plans)) {
        const id = `${c.id}-${name}`;
        roundtrips.push(id);
        const a = await reader.bytes(`${path}/${id}.input.fpln`),
          b = await reader.bytes(`${path}/${id}.decoded.fpln`);
        assert.deepEqual(a.bytes, b.bytes);
        assert.deepEqual(b.bytes, Buffer.from(bytes));
        plans[name] = runtime.decodeFramePlan(new Uint8Array(bytes));
      }
      const final = runtime.readFinalOutputPlan(plans.output),
        motion = runtime.readMotionReconstructionPlan(plans.motion);
      assert.deepEqual(final.header, motion.header);
      const motionReady = c.id.startsWith("motion-") || c.id.startsWith("depth-tier");
      assert.equal(motion.slice.status, motionReady ? "ready" : "skipped");
      assert.equal(
        final.header.aa,
        c.id.endsWith("ssaa4x")
          ? "ssaa4x"
          : c.id.endsWith("ssaa2x")
            ? "ssaa2x"
            : c.id.endsWith("fxaa")
              ? "fxaa"
              : "off",
      );
      if (plans.effect) {
        const e = runtime.readPostEffectPlan(plans.effect);
        assert.deepEqual(e.header, final.header);
        assert.equal(e.slice.effect.kind, final.route.kind);
        assert.equal(e.slice.effect.mode, final.route.mode);
      }
      assert.deepEqual(Object.keys(input.plans), [
        "output",
        "motion",
        ...(plans.effect ? ["effect"] : []),
      ]);
      const mutations = [
        "route",
        ...(plans.effect ? ["effect"] : []),
        ...(motionReady && final.route.kind === "beauty" ? ["motion"] : []),
      ];
      assert.deepEqual(
        result.mutations.map((m) => m.id),
        mutations,
      );
      for (const m of result.mutations) {
        assert.equal(m.file, `${c.id}.${m.id}.bin`);
        const altered = await reader.bytes(`${path}/${m.file}`);
        assert.equal(altered.bytes.length, actual.bytes.length);
        let changed = 0;
        for (let i = 0; i < actual.bytes.length; i += 4)
          if (!altered.bytes.subarray(i, i + 4).equals(actual.bytes.subarray(i, i + 4))) changed++;
        assert.equal(changed, m.changed_pixels);
        assert(changed > 16);
      }
      // Integer diagnostics previously failed GPU layout validation. Verify their colors
      // independently against the existing shader's u32 hash, not just the replay oracle.
      if (c.id === "objectId" || c.id === "materialId") {
        const attachment = input.attachments.find((a) => a.role === c.id),
          data = Buffer.from(attachment.bytes);
        for (let p = 0; p < 64 * 48; p++) {
          const id = data.readUInt32LE(p * 4);
          let value = id ^ (id >>> 16);
          value = Math.imul(value, 0x7feb352d);
          value ^= value >>> 15;
          value = Math.imul(value, 0x846ca68b);
          value ^= value >>> 16;
          assert.deepEqual(
            [...actual.bytes.subarray(p * 4, p * 4 + 4)],
            id ? [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255] : [0, 0, 0, 255],
          );
        }
      }
    }
    assert.deepEqual(gpu.roundtrips, roundtrips);
    assert.equal(
      gpu.results.reduce((n, c) => n + c.mutations.length, 0),
      37,
    );
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
    report: `${path}/gpu.json`,
    duration_ms: run.duration_ms,
  };
}
