import { describe, expect, it, vi } from "vitest";
import * as projectFiles from "../core/project/project-file";
import * as desktop from "../desktop/api";
import * as renderJobs from "../render-queue/render-job-builder";
import { createInitialState, editorReducer } from "../state/editor-store";
import { AutomationApplicationService } from "./automation-service";
import { parsePreviewOptions, previewCropPixels } from "./preview-options";
import { pixelDifference } from "./reference-comparison";

function fixture() {
  let state = createInitialState();
  const service = new AutomationApplicationService({
    read: () => state,
    commit: (operations, summary, expectedRevision) => {
      expect(state.projectRevision).toBe(expectedRevision);
      state = editorReducer(state, {
        type: "operation",
        operations,
        metadata: { source: "ai", summary },
      });
    },
    markSaved: (projectId, revision) => {
      state = editorReducer(state, { type: "markSaved", projectId, revision });
    },
    loadProject: (project) => {
      state = editorReducer(state, { type: "loadProject", project, markSaved: true });
    },
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    service.execute({ name, arguments: args, clientId: "test", requestId: "test" });
  const changeLive = () => {
    state = editorReducer(state, {
      type: "operation",
      operations: [
        {
          type: "renameLayer",
          layerId: state.project.compositions[0].layers[0].id,
          name: "User edit",
        },
      ],
    });
  };
  return { call, service, state: () => state, changeLive };
}

describe("external editor transactions", () => {
  it("opens a saved document, invalidates workspaces and preserves edits during loading", async () => {
    const f = fixture();
    const next = createInitialState().project;
    const work = await f.call("begin_edit_workspace", { baseRevision: 0 });
    const load = vi
      .spyOn(projectFiles, "loadProjectFromPath")
      .mockImplementation(async (_path, commit) => {
        commit?.assertCurrent();
        commit?.loaded(next);
        return { project: next, name: "next" };
      });
    try {
      await expect(
        f.call("open_project", { path: "/next", baseRevision: 0 }),
      ).resolves.toMatchObject({ projectId: next.id });
      expect(f.state().savedProjectRevision).toBe(0);
      expect(f.state().history.past).toHaveLength(0);
      await expect(f.call("commit_workspace", work as Record<string, unknown>)).rejects.toThrow(
        "Submit",
      );
      load.mockImplementationOnce(async (_path, commit) => {
        f.changeLive();
        commit?.assertCurrent();
        commit?.loaded(createInitialState().project);
        return { project: next, name: "next" };
      });
      await expect(f.call("open_project", { path: "/next", baseRevision: 0 })).rejects.toThrow(
        "Stale",
      );
      expect(f.state().project.compositions[0].layers[0].name).toBe("User edit");
      load.mockClear();
      await expect(f.call("open_project", { path: "/next", baseRevision: 1 })).rejects.toThrow(
        "Save unsaved",
      );
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });
  it("returns the exact durable render job ID when the builder leaves it unspecified", async () => {
    const f = fixture();
    const input = renderJobs.createRenderQueueJob({
      project: f.state().project,
      composition: f.state().project.compositions[0],
      projectRevision: 0,
      outputKind: "mp4",
      destination: "output.mp4",
      range: "composition",
      currentTime: 0,
    });
    expect(input.id).toBeUndefined();
    const build = vi.spyOn(renderJobs, "createRenderQueueJobAsync").mockResolvedValue(input);
    const enqueue = vi.fn(async () => ({ schemaVersion: 1 as const, revision: 1, items: [] }));
    const queue = vi
      .spyOn(desktop, "desktopRenderQueue")
      .mockReturnValue({ enqueue } as unknown as desktop.DesktopRenderQueue);
    try {
      const result = (await f.call("export_render", {
        path: "output.mp4",
        baseRevision: 0,
        outputKind: "mp4",
      })) as { jobId: string };
      expect(result.jobId).toMatch(/^[a-f0-9-]{36}$/);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: result.jobId }));
    } finally {
      build.mockRestore();
      queue.mockRestore();
    }
  });
  it("stages commands then commits once as one undoable transaction", async () => {
    const f = fixture();
    const layerId = f.state().project.compositions[0].layers[0].id;
    const work = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as {
      workspaceId: string;
      workspaceRevision: number;
    };
    await f.call("execute_commands", {
      ...work,
      commands: [{ type: "renameLayer", layerId, name: "Recreated" }],
    });
    expect(f.state().project.compositions[0].layers[0].name).not.toBe("Recreated");
    const input = { ...work, workspaceRevision: 1 };
    await expect(f.call("commit_workspace", input)).rejects.toThrow("Submit");
    await f.call("submit_workspace", { ...input, summary: "Recreate title" });
    await f.call("commit_workspace", input);
    expect(f.state().project.compositions[0].layers[0].name).toBe("Recreated");
    expect(f.state().history.past).toHaveLength(1);
    await expect(f.call("commit_workspace", input)).rejects.toThrow("Submit");
  });

  it("deduplicates commit retries and undoes a large workspace in one step", async () => {
    const f = fixture();
    const before = structuredClone(f.state().project);
    const work = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as {
      workspaceId: string;
      workspaceRevision: number;
    };
    const edited = (await f.call("execute_commands", {
      ...work,
      commands: Array.from({ length: 160 }, (_, i) => ({
        type: "addLayer",
        kind: "text",
        text: `Unit ${i}`,
      })),
    })) as { workspaceId: string; workspaceRevision: number };
    await f.call("submit_workspace", { ...edited, summary: "160 units" });
    const commit = { ...edited, requestId: "commit-once" };
    const result = await f.call("commit_workspace", commit);
    expect(await f.call("commit_workspace", commit)).toEqual(result);
    expect(f.state().history.past).toHaveLength(1);
    const undone = editorReducer(f.state(), { type: "undo" }).project;
    expect({ ...undone, commandLog: before.commandLog, updatedAt: before.updatedAt }).toEqual(
      before,
    );
    expect(await f.call("begin_edit_workspace", { baseRevision: 1 })).toMatchObject({
      baseRevision: 1,
      workspaceRevision: 0,
    });
  });

  it("preserves staged work after transport cancellation and reports commit conflicts", async () => {
    const f = fixture();
    const work = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as {
      workspaceId: string;
      workspaceRevision: number;
    };
    const edited = (await f.call("execute_commands", {
      ...work,
      commands: [{ type: "addLayer", kind: "text", text: "preserved" }],
    })) as { workspaceId: string; workspaceRevision: number };
    f.service.interrupt("test");
    expect(await f.call("get_workspace_status", edited)).toMatchObject({
      workspaceRevision: 1,
      state: "editable",
    });
    await f.call("submit_workspace", { ...edited, summary: "pending" });
    f.changeLive();
    await expect(f.call("commit_workspace", edited)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await f.call("get_workspace_status", edited)).toMatchObject({
      workspaceRevision: 1,
      state: "submitted",
    });
  });

  it("does not execute a queued idempotent call after cancellation", async () => {
    const f = fixture();
    const pending = f.call("begin_edit_workspace", {
      baseRevision: 0,
      requestId: "cancel-before-start",
    });
    f.service.interrupt("test");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(
      await f.call("begin_edit_workspace", { baseRevision: 0, requestId: "fresh-start" }),
    ).toMatchObject({ workspaceRevision: 0 });
  });

  it("preserves concurrent user edits and drops cancelled workspaces", async () => {
    const f = fixture();
    const work = (await f.call("begin_edit_workspace", { baseRevision: 0 })) as {
      workspaceId: string;
      workspaceRevision: number;
    };
    await f.call("execute_commands", {
      ...work,
      commands: [
        {
          type: "renameLayer",
          layerId: f.state().project.compositions[0].layers[0].id,
          name: "Agent edit",
        },
      ],
    });
    const input = { ...work, workspaceRevision: 1 };
    await f.call("submit_workspace", { ...input, summary: "Staged" });
    f.changeLive();
    await expect(f.call("commit_workspace", input)).rejects.toThrow("Stale");
    expect(f.state().project.compositions[0].layers[0].name).toBe("User edit");
    f.service.cancel("test");
    await expect(f.call("commit_workspace", input)).rejects.toThrow("Submit");
    expect(await f.call("get_editor_context")).toMatchObject({ projectRevision: 1 });
  });
});

describe("reference observation", () => {
  it("accepts default preview options and bounds normalized crop and resolution", () => {
    expect(parsePreviewOptions({})).toBeDefined();
    expect(previewCropPixels(1920, 1080, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toEqual({
      x: 480,
      y: 270,
      width: 960,
      height: 540,
    });
    expect(() => parsePreviewOptions({ maxDimension: 4096 })).toThrow();
    expect(() => parsePreviewOptions({ crop: { x: 0.9, y: 0, width: 0.5, height: 1 } })).toThrow(
      "inside",
    );
  });

  it("measures visible pixel differences without treating transparent RGB as a mismatch", () => {
    expect(
      pixelDifference(new Uint8ClampedArray([255, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 255]))
        .meanAbsoluteRgbError,
    ).toBe(0);
    expect(
      pixelDifference(
        new Uint8ClampedArray([255, 255, 255, 255]),
        new Uint8ClampedArray([0, 0, 0, 255]),
      ).meanAbsoluteRgbError,
    ).toBe(1);
    expect(() => pixelDifference(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow(
      "equal",
    );
  });
});
