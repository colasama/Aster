import assert from "node:assert/strict";
import test from "node:test";
import { auditM8Performance } from "./m8-performance.mjs";
import { exportStreamResponses } from "./m8-session.mjs";
import { validateReadOnlySchedule } from "./native-corpus-schedule.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";

test("M8 performance audit rejects partial, stale and smoke evidence before opening artifacts", async () => {
  const source = { source_sha256: "a".repeat(64) };
  const gate = {
    status: "passed",
    smoke: false,
    full_coverage: true,
    execution_complete: true,
    source_unchanged: true,
    source,
    source_after: source,
    workloads: nativeExportWorkloads.map((id) => ({ id })),
  };
  const reader = {
    get root() {
      throw new Error("unexpected artifact access");
    },
  };
  for (const mutate of [
    (r) => {
      r.full_coverage = false;
    },
    (r) => {
      r.smoke = true;
    },
    (r) => {
      r.source_after = { source_sha256: "b".repeat(64) };
    },
    (r) => {
      r.source_unchanged = false;
    },
    (r) => {
      r.workloads.pop();
    },
    (r) => {
      r.workloads[1] = r.workloads[0];
    },
  ]) {
    const changed = structuredClone(gate);
    mutate(changed);
    await assert.rejects(
      auditM8Performance(reader, changed, { source }, {}),
      (error) => error instanceof assert.AssertionError,
    );
  }
});

test("saved native streams reject truncated payloads, missing replies and reordered request identities", () => {
  const packet = (id, payload, declared = payload.length) =>
    Buffer.concat([
      Buffer.from(
        `${JSON.stringify({ version: 1, request_id: id, payload_bytes: declared, response: { type: "encoded", packets: [] } })}\n`,
      ),
      payload,
    ]);
  const payload = Buffer.from([0, 10, 255, 0, 1]);
  assert.deepEqual(
    exportStreamResponses(Buffer.concat([packet(1, payload), packet(2, Buffer.alloc(0))])),
    [
      { type: "encoded", packets: [] },
      { type: "encoded", packets: [] },
    ],
  );
  for (const malformed of [
    packet(1, payload, 6),
    packet(1, payload, -1),
    packet(2, payload),
    Buffer.concat([packet(1, payload), packet(1, payload)]),
    Buffer.from('{"version":1}'),
  ])
    assert.throws(() => exportStreamResponses(malformed));
});

test("read-only export audit refuses missing, partial, duplicate and unaccepted checkpoints", () => {
  const ids = ["a", "b"];
  const fixture = {
    status: "passed",
    full_coverage: true,
    cases: ids.map((id) => ({
      id,
      status: "passed",
      authenticated: true,
      checkpoint: { path: `${id}.json`, sha256: "a".repeat(64) },
    })),
  };
  validateReadOnlySchedule(fixture, ids);
  assert.throws(() => validateReadOnlySchedule(null, ids));
  for (const mutate of [
    (r) => {
      r.cases.pop();
    },
    (r) => {
      r.cases[1] = r.cases[0];
    },
    (r) => {
      r.cases[0].checkpoint = null;
    },
    (r) => {
      r.cases[0].authenticated = false;
    },
    (r) => {
      r.cases[0].status = "awaiting-self-review";
    },
    (r) => {
      r.full_coverage = false;
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => validateReadOnlySchedule(changed, ids));
  }
});
