import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function runNativeAuxiliaryPrimaryGate(context, execute = runStep) {
  const report = { status: "failed", scope: "five primary MRT attachments", cases: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_auxiliary_primary;
    assert(frozen, "Native auxiliary input manifest must be pinned");
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const base = "tests/parity/native-auxiliary-primary";
    assert.equal(manifest.reference_manifest, ledger.reference_baseline.auxiliary.path);
    assert.equal(manifest.reference_manifest_sha256, ledger.reference_baseline.auxiliary.sha256);
    const reference = await reader.json(
      manifest.reference_manifest,
      manifest.reference_manifest_sha256,
    );
    const ids = ["basic", "tier0", "tier1", "tier2", "no-motion", "cleared"];
    assert.deepEqual(
      manifest.cases.map((c) => c.id),
      ids,
    );
    assert.equal(manifest.width, 64);
    assert.equal(manifest.height, 48);
    for (const file of manifest.files) await reader.bytes(`${base}/${file.path}`, file.sha256);
    report.gpu = await execute(
      {
        id: "native-auxiliary-primary-gpu",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "auxiliary_primary_supplied_gpu_outputs_and_controls",
          "--",
          "--ignored",
        ],
        env: { ASTER_AUXILIARY_PRIMARY_OUTPUT: context.output },
      },
      context,
    );
    assert.equal(report.gpu.status, "passed");
    for (const c of manifest.cases) {
      const old = reference.cases.find((r) => r.id === c.id);
      assert.equal(c.reference, old.path);
      assert.equal(c.reference_sha256, old.sha256);
      assert.deepEqual(
        old.targets.slice(0, 5).map((t) => t.name),
        ["normal", "objectId", "materialId", "worldPosition", "motionVector"],
      );
      const expected = await reader.bytes(old.path, old.sha256);
      const actual = await reader.bytes(local(join(context.output, `${c.id}.bin`)));
      assert.equal(actual.bytes.length, 64 * 48 * 28);
      let offset = 0;
      const targets = old.targets.slice(0, 5).map((target) => {
        const a = actual.bytes.subarray(offset, offset + target.bytes);
        const b = expected.bytes.subarray(offset, offset + target.bytes);
        assert.deepEqual(a, b, `${c.id} ${target.name} differs`);
        offset += target.bytes;
        return {
          name: target.name,
          bytes: target.bytes,
          exact: true,
          reference_sha256: hash(b),
          candidate_sha256: hash(a),
        };
      });
      assert.equal(offset, actual.bytes.length);
      report.cases.push({
        case_id: c.id,
        profile: "exact",
        targets,
        evidence: local(join(context.output, `${c.id}.bin`)),
      });
    }
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
