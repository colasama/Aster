import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { auditTemporalPassReplay } from "./temporal-pass-capture.mjs";

test("temporal pass evidence rejects changed plans, output and sample coverage", async () => {
  const runtime = await loadIrRuntime(process.cwd());
  try {
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const fixture = runtime
      .temporalPassFixtures()
      .find((f) => f.id === "temporal-pass-transparent");
    const decoded = runtime.decodeFramePlan(fixture.bytes);
    decoded.metadata.header.snapshot_scope = "temporal-gpu";
    const wire = Buffer.from(runtime.encodeFramePlan(decoded.metadata, decoded.blobs));
    const pixels = Buffer.alloc(64 * 32 * 4);
    const record = {
      mode: "transparent",
      samples: [],
      plan_sha256: sha(wire),
      replay_sha256: sha(pixels),
      output_bytes: pixels.length,
      exact: true,
      rust_roundtrip: true,
      independent_device: true,
    };
    const output = { frame_hash: fixture.passes.output, width: 64, height: 32, samples: 0 };
    const reader = {
      bytes: async (path, expected) => {
        const bytes = path.endsWith(".fpln") ? wire : pixels;
        assert.equal(sha(bytes), expected);
        return { bytes };
      },
    };
    const audit = (value) =>
      auditTemporalPassReplay(reader, "evidence", runtime, value, output, { bytes: pixels }, []);
    await audit(record);
    await assert.rejects(audit({ ...record, samples: [{}] }));
    await assert.rejects(audit({ ...record, plan_sha256: "0".repeat(64) }));
    await assert.rejects(audit({ ...record, replay_sha256: "0".repeat(64) }));
    await assert.rejects(audit({ ...record, independent_device: false }));
  } finally {
    await runtime.close();
  }
});
