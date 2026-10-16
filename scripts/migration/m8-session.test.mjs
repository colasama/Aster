import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { auditInitializationRecovery } from "./m8-session.mjs";

test("recovery audit authenticates the failed prefix and rejects changed input or transport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-recovery-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = "2026-01-01T00:00:00.000Z";
  const prefix = [
    { type: "capabilities", encoder: { hardware_only: true, test_frame_verified: true } },
    { type: "resource_stored" },
  ];
  const bytes = Buffer.from(
    `${prefix
      .map((response, index) =>
        JSON.stringify({ version: 1, request_id: index + 1, payload_bytes: 0, response }),
      )
      .join("\n")}\n`,
  );
  const failure = {
    command: ["native.exe", "serve", "--native-export", "--dxcompiler", "compiler.dll"],
    input_sha256: sha256(Buffer.from("same ordered request stream")),
    started_at: startedAt,
    finished_at: "2026-01-01T00:00:01.000Z",
    exit_code: 0xc0000005,
    signal: null,
    output: "failure.bin",
    output_sha256: sha256(bytes),
  };
  const record = Buffer.from(JSON.stringify(failure));
  await writeFile(join(root, "failure.bin"), bytes);
  await writeFile(join(root, "failure.json"), record);
  const check = {
    command: ["native.exe", "serve", "--native-readback-export", "--dxcompiler", "compiler.dll"],
    input_sha256: failure.input_sha256,
    finished_at: "2026-01-01T00:00:02.000Z",
    responses: [
      ...prefix,
      { type: "export_started", transport: "nv12-readback" },
      { type: "encoded", encoder: { gpu_input_frames: 0, retired_gpu_frames: 0 } },
    ],
    initialization_failure: {
      ...failure,
      prefix_length: prefix.length,
      record: { path: "failure.json", sha256: sha256(record) },
    },
  };
  await auditInitializationRecovery(new M0Evidence(root), check, startedAt);
  for (const mutate of [
    (r) => {
      r.input_sha256 = "f".repeat(64);
    },
    (r) => {
      r.command[0] = "another.exe";
    },
    (r) => {
      r.command[2] = "--native-export";
    },
    (r) => {
      r.command[4] = "another.dll";
    },
    (r) => {
      r.finished_at = "2025-01-01T00:00:00.000Z";
    },
    (r) => {
      r.initialization_failure.prefix_length = 1;
    },
    (r) => {
      r.initialization_failure.exit_code = 0;
    },
    (r) => {
      r.initialization_failure.record.sha256 = "f".repeat(64);
    },
    (r) => {
      r.responses[2].type = "encoded";
    },
    (r) => {
      r.responses[2].transport = "nv12-shared";
    },
    (r) => {
      r.responses[3].encoder.gpu_input_frames = 1;
    },
    (r) => {
      r.responses[3].encoder.retired_gpu_frames = 1;
    },
  ]) {
    const changed = structuredClone(check);
    mutate(changed);
    await assert.rejects(auditInitializationRecovery(new M0Evidence(root), changed, startedAt));
  }
  await assert.rejects(
    auditInitializationRecovery(new M0Evidence(root), check, "2026-01-02T00:00:00.000Z"),
  );
  await writeFile(join(root, "failure.bin"), Buffer.concat([bytes, Buffer.from("extra\n")]));
  await assert.rejects(auditInitializationRecovery(new M0Evidence(root), check, startedAt));
});
