import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { evidencePath, M0Evidence, validSha } from "./m0-evidence.mjs";

// This narrow list covers the diagnostic acceptance repair and its checkpoint auditing only.
// Runtime, renderer, shaders, fixtures, dependencies and tolerance catalogs are deliberately absent.
const verificationFiles = new Set([
  "docs/migration/RUST_RENDERER_MIGRATION.md",
  "scripts/migration/checkpoint-source.mjs",
  "scripts/migration/checkpoint-source.test.mjs",
  "scripts/migration/diagnostic-quality-review.mjs",
  "scripts/migration/diagnostic-structural-audit.mjs",
  "scripts/migration/diagnostic-structural-audit.test.mjs",
  "scripts/migration/diagnostic-structural-inputs.mjs",
  "scripts/migration/diagnostic-structural-witness.mjs",
  "scripts/migration/m8-quality.mjs",
  "scripts/migration/native-corpus-schedule.mjs",
  "scripts/migration/native-corpus-rgb.mjs",
  "scripts/migration/native-corpus-rgb.test.mjs",
  "scripts/migration/native-encoded-quality-case.mjs",
  "scripts/migration/native-export-checkpoint.mjs",
  "scripts/migration/native-export-gate.mjs",
  "scripts/migration/native-nv12-corpus.mjs",
  "scripts/migration/verify.mjs",
  "scripts/migration/verify.test.mjs",
]);

/** Authenticate complete historical inventories against the original execution digest. */
export function snapshotExecution(snapshot) {
  assert.equal(snapshot.files.length, snapshot.source.source_file_count);
  const paths = snapshot.files.map((f) => evidencePath(f.path));
  assert.deepEqual(
    paths,
    [...new Set(paths)].sort(),
    "Source inventory is incomplete or unordered",
  );
  const execution = createHash("sha256");
  for (const file of snapshot.files) {
    assert(typeof file.identity === "string" && file.identity.length > 0);
    if (file.path !== "docs/migration/rust-renderer-progress.json")
      execution.update(`${file.path}\0${file.identity}\0`);
  }
  const digest = execution.digest("hex");
  assert.equal(
    digest,
    validSha(snapshot.source.execution_sha256),
    "Source inventory digest differs",
  );
  return digest;
}

export function verifyCheckpointSourceDelta(before, after) {
  const original = snapshotExecution(before),
    current = snapshotExecution(after);
  const oldFiles = new Map(before.files.map((f) => [f.path, f.identity]));
  const newFiles = new Map(after.files.map((f) => [f.path, f.identity]));
  const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .sort()
    .filter(
      (path) =>
        path !== "docs/migration/rust-renderer-progress.json" &&
        oldFiles.get(path) !== newFiles.get(path),
    );
  assert(changed.length > 0, "Identical execution sources need no compatibility exception");
  for (const path of changed)
    assert(verificationFiles.has(path), `Checkpoint production dependency changed: ${path}`);
  return { original, current, changed };
}

/** Compatibility never grants a gate: every artifact, input, binary and review is still audited. */
export async function checkpointSource(context, prior) {
  const current = validSha(context.source.execution_sha256);
  let delta = null;
  const pin = prior?.source_compatibility;
  if (pin) {
    const reader = new M0Evidence(context.root);
    const proof = await reader.json(pin.path, validSha(pin.sha256));
    assert.equal(proof.kind, "verification-only-checkpoint-source-v1");
    const before = await reader.json(proof.before.path, validSha(proof.before.sha256));
    const after = await reader.json(proof.after.path, validSha(proof.after.sha256));
    delta = verifyCheckpointSourceDelta(before, after);
    assert.equal(delta.current, current, "Checkpoint compatibility proof is stale");
    assert.deepEqual(proof.changed, delta.changed);
    await reader.stable();
  }
  return {
    pin,
    assert(digest) {
      validSha(digest);
      assert(
        digest === current || digest === delta?.original,
        "Checkpoint execution source changed",
      );
    },
  };
}
