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
    "crates/aster-eval/src/lib.rs",
    "scripts/migration/native-project-runtime.mjs",
    "scripts/migration/native-project-corpus-inputs.mjs",
    "scripts/migration/native-project-export-runs.mjs",
    "scripts/parity/pixel-inputs.mjs",
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

test("source inventories reject NUL-folded identity and path entries", () => {
  const allowed = "scripts/migration/verify.mjs";
  const runtime = "src/native-runtime.ts";
  for (const value of ["before", "after"]) {
    const original = snapshot({ [allowed]: "verifier", [runtime]: value });
    const foldedIdentity = {
      files: [{ path: allowed, identity: `verifier\0${runtime}\0${value}` }],
      source: { ...original.source, source_file_count: 1 },
    };
    const foldedPath = {
      files: [{ path: `${allowed}\0verifier\0${runtime}`, identity: value }],
      source: { ...original.source, source_file_count: 1 },
    };
    assert.throws(() => snapshotExecution(foldedIdentity), /NUL separator/);
    assert.throws(() => snapshotExecution(foldedPath), /NUL separator/);
  }
});

test("multiple historical sources each authenticate directly against the complete current inventory", async (t) => {
  const f = await fixture(t);
  const verifier = "scripts/migration/native-export-gate.mjs";
  const runtime = "crates/aster-eval/src/lib.rs";
  const snapshots = ["oldest", "previous", "current"].map((identity) =>
    snapshot({ [verifier]: identity, [runtime]: "unchanged" }),
  );
  const pins = [];
  for (const [index, value] of snapshots.entries()) {
    const path = `source-${index}.json`;
    await f.json(path, value);
    pins.push({ path, sha256: await f.hash(path) });
  }
  const current = snapshots[2];
  const context = { root: f.root, source: current.source };
  const proof = {
    kind: "verification-only-checkpoint-source-v2",
    after: pins[2],
    histories: snapshots.slice(0, 2).map((value, index) => ({
      before: pins[index],
      changed: verifyCheckpointSourceDelta(value, current).changed,
    })),
  };
  const publish = async (value) => {
    await f.json("proof.json", value);
    return { source_compatibility: { path: "proof.json", sha256: await f.hash("proof.json") } };
  };
  const accepted = await checkpointSource(context, await publish(proof));
  for (const value of snapshots) accepted.assert(value.source.execution_sha256);
  assert.throws(() => accepted.assert("f".repeat(64)), /execution source changed/);

  for (const [name, mutate, expected] of [
    [
      "empty",
      (p) => {
        p.histories = [];
      },
      /historical inventories/,
    ],
    [
      "duplicate",
      (p) => {
        p.histories.push(p.histories[0]);
      },
      /Duplicate/,
    ],
    [
      "unlisted-delta",
      (p) => {
        p.histories[0].changed = [];
      },
      /deep-equal/,
    ],
    [
      "stale",
      (p) => {
        p.after = pins[1];
      },
      /stale/,
    ],
    [
      "bad-pin",
      (p) => {
        p.histories[0].before.sha256 = "a".repeat(64);
      },
      /SHA-256/,
    ],
    [
      "unknown-kind",
      (p) => {
        p.kind = "unverified-source-list";
      },
      /Unknown/,
    ],
  ]) {
    const changed = structuredClone(proof);
    mutate(changed);
    await assert.rejects(checkpointSource(context, await publish(changed)), expected, name);
  }

  const changedRuntime = snapshot({ [verifier]: "oldest", [runtime]: "different" });
  await f.json("changed-runtime.json", changedRuntime);
  const invalid = structuredClone(proof);
  invalid.histories[0].before = {
    path: "changed-runtime.json",
    sha256: await f.hash("changed-runtime.json"),
  };
  invalid.histories[0].changed = [runtime, verifier].sort();
  await assert.rejects(
    checkpointSource(context, await publish(invalid)),
    /production dependency changed/,
  );
});
