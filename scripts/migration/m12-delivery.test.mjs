import assert from "node:assert/strict";
import test from "node:test";
import {
  auditDeliveryDocuments,
  auditProductionRetirement,
  deliveryDocuments,
} from "./m12-delivery.mjs";

test("M12 delivery requires a complete documentation review whose files still match", async () => {
  const files = deliveryDocuments.map((path) => ({ path, sha256: "a".repeat(64) }));
  const milestone = { tasks: [{ id: "M12-T8", documentation: { status: "passed", files } }] };
  const reader = {
    async bytes(path, sha) {
      assert(deliveryDocuments.includes(path));
      assert.equal(sha, "a".repeat(64));
    },
  };
  await auditDeliveryDocuments(reader, milestone);
  for (const mutate of [
    (m) => {
      m.tasks[0].documentation.status = "pending";
    },
    (m) => {
      m.tasks[0].documentation.files.pop();
    },
    (m) => {
      m.tasks[0].documentation.files[0].sha256 = "b".repeat(64);
    },
    (m) => {
      m.tasks[0].documentation.files.push(m.tasks[0].documentation.files[0]);
    },
  ]) {
    const m = structuredClone(milestone);
    mutate(m);
    await assert.rejects(auditDeliveryDocuments(reader, m));
  }
});

function fixture() {
  const pin = (path) => ({ path, sha256: "a".repeat(64) });
  const gate = {
    evidence: { package: pin("package.json"), queue: pin("queue.json") },
    packaged_app: pin("app.asar"),
    preview: { packaged_renderer: pin("packaged.exe") },
    outputs: Array.from({ length: 14 }, (_, i) => pin(`output${i}`)),
  };
  const packaged = {
    status: "passed",
    archive_sha256: "a".repeat(64),
    boundary: { schema_version: 1, reference: false, retained_modules: [] },
  };
  const queue = {
    status: "passed",
    host_ipc: [],
    retired_ipc_registrations: [],
    native_jobs_cleaned: true,
    outputs: ["still", "pngSequence", "mp4"].map((kind, id) => ({
      id,
      kind,
      result: { status: "completed" },
    })),
    launches: [0, 1, 2].map((jobId) => ({ jobId })),
    persisted_jobs: [0, 1, 2].map((id) => ({ id, status: "completed" })),
    png: { first_frame_exact: true, sequence_frames: 12 },
  };
  const reader = {
    async json(path) {
      return path === "package.json" ? packaged : queue;
    },
    async bytes(_path, sha) {
      assert.equal(sha, "a".repeat(64));
    },
  };
  return {
    gate,
    queue,
    packaged,
    reader,
    performance: { native_binaries: [pin("target/release/aster-render-cli.exe")] },
  };
}

test("M12 retirement binds the actual package, native queue outputs and measured renderer", async () => {
  const f = fixture();
  assert.equal((await auditProductionRetirement(f.reader, f.gate, f.performance)).status, "passed");
  for (const mutate of [
    (v) => {
      v.packaged.boundary.reference = true;
    },
    (v) => {
      v.packaged.boundary.retained_modules.push("webgpu-renderer.ts");
    },
    (v) => {
      v.queue.host_ipc.push("renderHost");
    },
    (v) => {
      v.queue.native_jobs_cleaned = false;
    },
    (v) => {
      v.queue.launches[1].jobId = 0;
    },
    (v) => {
      v.queue.persisted_jobs[0].status = "running";
    },
    (v) => {
      v.gate.outputs.pop();
    },
    (v) => {
      v.gate.preview.packaged_renderer.sha256 = "b".repeat(64);
    },
  ]) {
    const v = fixture();
    mutate(v);
    await assert.rejects(auditProductionRetirement(v.reader, v.gate, v.performance));
  }
});
