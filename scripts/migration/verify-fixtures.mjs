import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicJson } from "./report.mjs";
import { runStaticChecks } from "./static-checks.mjs";

export async function fixture(t, gates = ["G0", "G6"]) {
  const root = await mkdtemp(join(tmpdir(), "aster-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, "docs", "migration", "rust-renderer-progress.json");
  await writeAtomicJson(ledger, {
    status: "running",
    milestones: [
      { id: "M0", status: "in_progress", gates, tasks: [{ id: "M0-T1", status: "pending" }] },
    ],
  });
  return { root, ledger, output: join(root, "logs"), env: process.env };
}

export async function fakeHook(command, context) {
  assert.equal(command.id, "lefthook-static");
  await runStaticChecks(context, context.env.ASTER_MIGRATION_QUICK === "1", async (step) => ({
    id: step.id,
    status: "passed",
  }));
  return { id: command.id, status: "passed", duration_ms: 1 };
}

export const provenance = async () => ({ source_sha256: "source-123", commit: "123", dirty: true });

export const deliveryPolicy = {
  kind: "rust-delivery-v1",
  status: "approved",
  authorization_received: true,
  approved_at: "2026-01-01T00:00:00.000Z",
  authorization_text: "CPU test fixture: intermediate performance is informational",
  intermediate_milestones: ["M2", "M4", "M6", "M7"],
  intermediate_performance: "informational",
  native_performance: "higher-median-fps-than-contemporaneous-ts",
  native_milestones: ["M8", "M11", "M12"],
};
