import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CaptureStore, publishCaptures } from "./capture-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-parity-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    root,
    runId: "test",
    runDirectory: join(root, "artifacts", "parity", "runs", "test"),
    source: { commit: "test", renderer_source_sha256: "source", tree_sha256: "tree" },
  };
  const assignment = {
    case: { id: "test-case", size: { width: 1, height: 1 }, aa: "off", frames: [0] },
    frames: [0],
    caseHash: "case",
    inputs: {},
  };
  const payload = {
    caseId: "test-case",
    frame: 0,
    time: 0,
    frameRate: { numerator: 30, denominator: 1 },
    width: 1,
    height: 1,
    pixels: new Uint8Array([27, 81, 139, 1]),
    diagnostics: {},
    timings: {},
  };
  const store = new CaptureStore(config, {
    cacheIdentity: {
      adapter: "test",
      driver: "test",
      fonts: { status: "available", sha256: "fonts" },
    },
  });
  return { root, config, assignment, payload, store };
}

test("a complete staged case is not a reference until inputs have been verified", async (t) => {
  const { root, config, assignment, payload, store } = await fixture(t);
  await store.writeFrame(assignment, payload);
  await store.completeCase(assignment, {
    caseId: assignment.case.id,
    elapsed_ms: 1,
    diagnostics: {},
  });
  assert.equal(await store.cached(assignment), false);
  await assert.rejects(
    publishCaptures(config, { status: "passed", source_unchanged: false, cases: [] }),
    /changed inputs/,
  );
  await assert.rejects(
    publishCaptures(config, {
      status: "failed",
      source_unchanged: true,
      cases: [{ id: assignment.case.id, status: "passed" }],
    }),
    /failed capture run/,
  );
  assert.equal(await store.cached(assignment), false);
  await publishCaptures(config, {
    status: "passed",
    source_unchanged: true,
    cases: [{ id: assignment.case.id, status: "passed" }],
  });
  assert.equal(await store.cached(assignment), true);
  const candidateConfig = { ...config, candidate: true };
  assert.equal(await new CaptureStore(candidateConfig, store.host).cached(assignment), false);
  await assert.rejects(
    publishCaptures(candidateConfig, {
      status: "passed",
      source_unchanged: true,
      cases: [{ id: assignment.case.id, status: "passed" }],
    }),
    /must never publish references/,
  );
  const frame = join(
    root,
    "artifacts",
    "parity",
    "reference",
    assignment.case.id,
    "0",
    "frame.png",
  );
  const bytes = await readFile(frame);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(frame, bytes);
  assert.equal(await store.cached(assignment), false);
});

test("missing, duplicate and unrequested frames cannot complete a case", async (t) => {
  const { assignment, payload, store } = await fixture(t);
  await assert.rejects(store.completeCase(assignment, { caseId: assignment.case.id }));
  await assert.rejects(store.writeFrame(assignment, { ...payload, frame: 2 }));
  await store.writeFrame(assignment, payload);
  await assert.rejects(store.writeFrame(assignment, payload));
});

test("the cache binds renderer source, case resources and stable adapter identity", async (t) => {
  const { config, assignment, payload, store } = await fixture(t);
  await store.writeFrame(assignment, payload);
  await store.completeCase(assignment, { caseId: assignment.case.id, elapsed_ms: 1 });
  await publishCaptures(config, {
    status: "passed",
    source_unchanged: true,
    cases: [{ id: assignment.case.id, status: "passed" }],
  });
  assert.equal(await store.cached({ ...assignment, caseHash: "changed" }), false);
  const changedDriver = new CaptureStore(config, {
    cacheIdentity: { adapter: "test", driver: "changed" },
  });
  assert.equal(await changedDriver.cached(assignment), false);
  const changedSource = new CaptureStore(
    { ...config, source: { ...config.source, renderer_source_sha256: "changed" } },
    store.host,
  );
  assert.equal(await changedSource.cached(assignment), false);
  const ledgerOnly = new CaptureStore(
    { ...config, source: { ...config.source, tree_sha256: "changed" } },
    store.host,
  );
  assert.equal(await ledgerOnly.cached(assignment), true);
  const noFonts = new CaptureStore(config, {
    cacheIdentity: { ...store.host.cacheIdentity, fonts: { status: "unavailable" } },
  });
  assert.equal(await noFonts.cached(assignment), false);
});
