import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { fixture } from "./m0-exit-fixtures.mjs";
import {
  auditNativeRgbSupplement,
  missingNativeRgbFrames,
  readNativeRgbSupplement,
} from "./native-corpus-rgb.mjs";

test("whole-corpus RGB coverage cannot omit owner/example frames or duplicate covered frames", () => {
  const corpus = {
    cases: [
      { id: "shape", frames: [0] },
      { id: "enchanted-love", frames: [0, 1] },
      { id: "owner-opening", frames: [0, 713] },
      { id: "owner-main", frames: [714, 715] },
    ],
  };
  const covered = [{ case_id: "shape", frame: 0 }];
  const missing = missingNativeRgbFrames(corpus, covered);
  assert.equal(missing.length, 6);
  assert(missing.some((f) => f.case_id === "owner-main" && f.frame === 715));
  assert.deepEqual(missingNativeRgbFrames(corpus, [...covered, ...missing]), []);
  assert.throws(() => missingNativeRgbFrames(corpus, [...covered, ...covered]));
  assert.throws(() => missingNativeRgbFrames(corpus, [{ case_id: "shape", frame: 1 }]));
});

test("RGB supplement authenticates captured pixels and the exact or compatible execution source", async (t) => {
  const f = await fixture(t);
  const root = f.root,
    hash = "a".repeat(64);
  const receipt = {
    status: "passed",
    native_gpu_execution: true,
    plan_sha256: hash,
    rgba_sha256: hash,
    output: resolve(root, "artifacts/frame.png"),
    width: 2,
    height: 2,
  };
  const frame = {
    frame: 714,
    batch_index: 0,
    receipt,
    render_log: { path: "render.log", sha256: hash },
    png: { path: "artifacts/frame.png", sha256: hash },
  };
  const assignment = {
    case: { id: "owner-main", size: { width: 2, height: 2 } },
    inputs: [{ frame: 714, plan: { path: "plan.fpln", sha256: hash } }],
  };
  const binary = { path: "renderer.exe", sha256: hash };
  const checkpoint = {
    execution_sha256: hash,
    assignment,
    report: { path: "capture.json", sha256: hash },
  };
  const capture = { binary, assignment, frames: [frame] };
  const conversion = {
    full_coverage: true,
    source_unchanged: true,
    source: { execution_sha256: hash },
    binary,
    cases: [
      {
        id: "owner-main",
        authenticated: true,
        checkpoint: { path: "checkpoint.json", sha256: hash },
      },
    ],
  };
  const required = [{ case_id: "owner-main", frame: 714 }];
  const reader = {
    root,
    json: async (path, sha) => {
      assert.equal(sha, hash);
      return path === "checkpoint.json" ? checkpoint : capture;
    },
    bytes: async (path, sha) => {
      assert.equal(sha, hash);
      return {
        bytes: Buffer.from(
          path === "render.log" ? JSON.stringify({ schema_version: 1, ...receipt }) : "plan",
        ),
      };
    },
    image: async (path, sha) => {
      assert.equal(path, frame.png.path);
      assert.equal(sha, hash);
      return { rgba_sha256: hash };
    },
  };
  receipt.schema_version = 1;
  assert.equal((await readNativeRgbSupplement(reader, conversion, required)).length, 1);
  for (const mutate of [
    (c) => {
      c.full_coverage = false;
    },
    (c) => {
      c.source_unchanged = false;
    },
    (c) => {
      c.source.execution_sha256 = "b".repeat(64);
    },
    (c) => {
      c.cases[0].authenticated = false;
    },
  ]) {
    const changed = structuredClone(conversion);
    mutate(changed);
    await assert.rejects(readNativeRgbSupplement(reader, changed, required));
  }
  await assert.rejects(
    readNativeRgbSupplement(
      { ...reader, image: async () => ({ rgba_sha256: "b".repeat(64) }) },
      conversion,
      required,
    ),
  );
  await assert.rejects(
    readNativeRgbSupplement(
      {
        ...reader,
        bytes: async () => ({ bytes: Buffer.from('{"schema_version":1,"status":"failed"}') }),
      },
      conversion,
      required,
    ),
  );
  await assert.rejects(
    readNativeRgbSupplement(reader, conversion, [{ case_id: "owner-main", frame: 715 }]),
  );
  // A proof must survive through the RGB consumer, not merely the preceding NV12 gate.
  const path = "scripts/migration/native-corpus-rgb.mjs";
  const inventories = [];
  for (const identity of ["c".repeat(64), "d".repeat(64)]) {
    inventories.push({
      files: [{ path, identity }],
      source: {
        source_file_count: 1,
        execution_sha256: createHash("sha256").update(`${path}\0${identity}\0`).digest("hex"),
      },
    });
  }
  await f.json("before.json", inventories[0]);
  await f.json("after.json", inventories[1]);
  await f.json("proof.json", {
    kind: "verification-only-checkpoint-source-v1",
    before: { path: "before.json", sha256: await f.hash("before.json") },
    after: { path: "after.json", sha256: await f.hash("after.json") },
    changed: [path],
  });
  checkpoint.execution_sha256 = inventories[0].source.execution_sha256;
  conversion.source = inventories[1].source;
  conversion.source_compatibility = { path: "proof.json", sha256: await f.hash("proof.json") };
  assert.equal((await readNativeRgbSupplement(reader, conversion, required)).length, 1);
  await assert.rejects(
    readNativeRgbSupplement(reader, { ...conversion, source_compatibility: undefined }, required),
  );
  checkpoint.execution_sha256 = "e".repeat(64);
  await assert.rejects(readNativeRgbSupplement(reader, conversion, required));
});

test("M8 exit refuses a missing or failed RGB supplement before trusting conversion coverage", async () => {
  for (const native of [{}, { native_rgb_supplement: { status: "failed" } }])
    await assert.rejects(auditNativeRgbSupplement({}, native, {}, {}));
});
