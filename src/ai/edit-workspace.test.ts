import { describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../core/project/project";
import { AsterAgentApplicationService } from "./application-service";
import { normalizeAiCommands } from "./command-normalizer";
import { EDIT_LIMITS } from "./edit-limits";
import type { EditTaskRunner } from "./edit-task";
import { executeScript } from "./script-runtime";

type Address = { workspaceId: string; workspaceRevision: number };
const localRunner: EditTaskRunner = async (task) =>
  task.commands
    ? { ...normalizeAiCommands(task.commands, task.project, task.currentTime), result: null }
    : executeScript({ ...task, code: task.code ?? "" });
function fixture(runner: EditTaskRunner = localRunner) {
  const project = createBlankProject();
  const service = new AsterAgentApplicationService({
    project,
    projectRevision: 0,
    selection: [],
    currentTime: 0,
    accessMode: "agent",
    primaryModelSupportsImages: false,
    runEditTask: runner,
  });
  const call = (name: string, input: Record<string, unknown> = {}) =>
    service.executeTool(name, input);
  return { project, service, call };
}
async function wait(f: ReturnType<typeof fixture>, executionId: string) {
  let status: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    status = (await f.call("get_execution", { executionId })) as Record<string, unknown>;
    expect(status.state).not.toBe("running");
  });
  return status;
}

describe("editing workspace resources and jobs", () => {
  it("accepts 256 commands, deduplicates retries, and enforces 4096 cumulative operations", async () => {
    const f = fixture();
    let address = (await f.call("begin_edit_workspace", {
      baseRevision: 0,
      requestId: "begin",
    })) as Address;
    expect(await f.call("begin_edit_workspace", { requestId: "begin", baseRevision: 0 })).toEqual(
      address,
    );
    const commands = Array.from({ length: 256 }, (_, i) => ({
      type: "renameLayer",
      layerId: f.project.compositions[0].layers[0].id,
      name: `Layer ${i}`,
    }));
    for (let i = 0; i < 16; i++) {
      const args = { ...address, commands, requestId: `batch-${i}` };
      address = (await f.call("execute_commands", args)) as Address;
      expect(await f.call("execute_commands", args)).toEqual(address);
    }
    await expect(
      f.call("execute_commands", { ...address, commands: [commands[0]] }),
    ).rejects.toMatchObject({
      code: "budget_exceeded",
      details: { resource: "operations", limit: 4096 },
    });
    expect(await f.call("get_workspace_status", address)).toMatchObject({
      workspaceRevision: 16,
      budgets: { operations: { used: 4096, limit: 4096 } },
    });
    await expect(
      f.call("begin_edit_workspace", { baseRevision: 1, requestId: "begin" }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
  });

  it("uses idle expiry, does not charge base project bytes and does not keep alive through status polling", async () => {
    const f = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const address = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as Address;
      expect(await f.call("get_workspace_status", address)).toMatchObject({
        budgets: { bytes: { used: 2 }, expiresAt: 1000 + EDIT_LIMITS.idleMs },
      });
      now.mockReturnValue(1000 + EDIT_LIMITS.idleMs - 1);
      await f.call("query_project", { workspaceId: address.workspaceId, kind: "layers" });
      now.mockReturnValue(1000 + 2 * EDIT_LIMITS.idleMs - 2);
      await f.call("get_workspace_status", address);
      now.mockReturnValue(1000 + 2 * EDIT_LIMITS.idleMs);
      await expect(f.call("get_workspace_status", address)).rejects.toMatchObject({
        code: "workspace_expired",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("creates a script workspace automatically, rolls failures back and continues without reconnecting", async () => {
    const f = fixture();
    const job = (await f.call("execute_aster_code", {
      baseRevision: 0,
      code: "return aster.compositions.active().layers.addText({text:'first'}).id;",
      requestId: "script-1",
    })) as { executionId: string; workspaceId: string };
    const done = await wait(f, job.executionId);
    expect(done).toMatchObject({ state: "succeeded", workspaceRevision: 1 });
    const address = { workspaceId: job.workspaceId, workspaceRevision: 1 };
    const failed = (await f.call("execute_aster_code", {
      ...address,
      code: "aster.compositions.active().layers.addText({text:'discarded'}); throw new Error('stop');",
    })) as { executionId: string };
    expect(await wait(f, failed.executionId)).toMatchObject({
      state: "failed",
      workspaceRevision: 1,
      error: { code: "script_failed" },
    });
    expect(await f.call("get_workspace_status", address)).toMatchObject({
      workspaceRevision: 1,
      budgets: { operations: { used: 1 } },
    });
    const layers = (await f.call("query_project", {
      workspaceId: job.workspaceId,
      kind: "layers",
    })) as { items: { name: string }[] };
    expect(layers.items).toHaveLength(2);
    expect(
      await f.call("submit_workspace", { ...address, summary: "Script changes" }),
    ).toMatchObject({ workspaceRevision: 1 });
  });

  it("cancels active work, holds the mutation lock, and preserves the previous revision", async () => {
    const runner: EditTaskRunner = (task, signal) =>
      task.commands
        ? localRunner(task, signal, () => {})
        : new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            if (signal.aborted) reject(new Error("cancelled"));
          });
    const f = fixture(runner);
    let address = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as Address;
    address = (await f.call("execute_commands", {
      ...address,
      commands: [{ type: "addLayer", kind: "text", text: "preserved" }],
    })) as Address;
    const job = (await f.call("execute_aster_code", { ...address, code: "while(true){}" })) as {
      executionId: string;
    };
    await expect(f.call("submit_workspace", { ...address, summary: "busy" })).rejects.toMatchObject(
      { code: "workspace_busy" },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * EDIT_LIMITS.idleMs);
    try {
      expect(await f.call("get_workspace_status", address)).toMatchObject({
        state: "running",
        budgets: { expiresAt: null },
      });
    } finally {
      now.mockRestore();
    }
    expect(await f.call("cancel_execution", { executionId: job.executionId })).toMatchObject({
      state: "cancelled",
    });
    expect(await f.call("get_workspace_status", address)).toMatchObject({
      state: "editable",
      workspaceRevision: 1,
      budgets: { operations: { used: 1 } },
    });
    expect(await f.call("submit_workspace", { ...address, summary: "preserved" })).toMatchObject({
      workspaceRevision: 1,
    });
  });
});
