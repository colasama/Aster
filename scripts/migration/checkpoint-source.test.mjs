import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  checkpointSource,
  snapshotExecution,
  verifyCheckpointSourceDelta,
} from "./checkpoint-source.mjs";
import { fixture } from "./m0-exit-fixtures.mjs";

function snapshot(entries) {
  const files = Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, identity]) => ({ path, identity }));
  const hash = createHash("sha256");
  for (const f of files)
    if (f.path !== "docs/migration/rust-renderer-progress.json")
      hash.update(`${f.path}\0${f.identity}\0`);
  return {
    files,
    source: { source_file_count: files.length, execution_sha256: hash.digest("hex") },
  };
}

test("complete source proof permits verifier changes but rejects every production dependency change", () => {
  const files = {
    "crates/aster-renderer/src/lib.rs": "1".repeat(64),
    "scripts/migration/native-export-gate.mjs": "2".repeat(64),
    "docs/migration/rust-renderer-progress.json": "3".repeat(64),
  };
  const before = snapshot(files);
  const next = {
    ...files,
    "scripts/migration/native-export-gate.mjs": "4".repeat(64),
    "docs/migration/rust-renderer-progress.json": "5".repeat(64),
  };
  assert.deepEqual(verifyCheckpointSourceDelta(before, snapshot(next)).changed, [
    "scripts/migration/native-export-gate.mjs",
  ]);
  for (const path of [
    "crates/aster-renderer/src/lib.rs",
    "electron/native-export-job.ts",
    "shaders/nv12.wgsl",
    "tests/parity/corpus.json",
    "tests/parity/tolerances.json",
    "Cargo.lock",
    "pnpm-lock.yaml",
    "new-file.mjs",
  ])
    assert.throws(
      () => verifyCheckpointSourceDelta(before, snapshot({ ...next, [path]: "6".repeat(64) })),
      /production dependency/,
    );
  delete next["crates/aster-renderer/src/lib.rs"];
  assert.throws(() => verifyCheckpointSourceDelta(before, snapshot(next)), /production dependency/);
  for (const mutate of [
    (s) => {
      s.files.pop();
    },
    (s) => {
      s.files.reverse();
    },
    (s) => {
      s.files[0].identity = "tampered";
    },
    (s) => {
      s.files[1] = s.files[0];
    },
    (s) => {
      s.source.execution_sha256 = "7".repeat(64);
    },
  ]) {
    const changed = structuredClone(before);
    mutate(changed);
    assert.throws(() => snapshotExecution(changed));
  }
});

test("proof-free reuse is exact; pinned compatibility rejects stale targets and third-party sources", async (t) => {
  const f = await fixture(t);
  const before = snapshot({ "scripts/migration/native-export-gate.mjs": "old" });
  const after = snapshot({ "scripts/migration/native-export-gate.mjs": "new" });
  const context = { root: f.root, source: after.source };
  const exact = await checkpointSource(context, null);
  exact.assert(after.source.execution_sha256);
  assert.throws(() => exact.assert(before.source.execution_sha256));
  await f.json("before.json", before);
  await f.json("after.json", after);
  const proof = {
    kind: "verification-only-checkpoint-source-v1",
    before: { path: "before.json", sha256: await f.hash("before.json") },
    after: { path: "after.json", sha256: await f.hash("after.json") },
    changed: verifyCheckpointSourceDelta(before, after).changed,
  };
  await f.json("proof.json", proof);
  const prior = {
    source_compatibility: { path: "proof.json", sha256: await f.hash("proof.json") },
  };
  const compatible = await checkpointSource(context, prior);
  compatible.assert(before.source.execution_sha256);
  compatible.assert(after.source.execution_sha256);
  assert.throws(() => compatible.assert("a".repeat(64)));
  await assert.rejects(checkpointSource({ ...context, source: before.source }, prior), /stale/);
  await f.json("after.json", before);
  await assert.rejects(checkpointSource(context, prior), /SHA-256/);
});
