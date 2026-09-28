import { describe, expect, it, vi } from "vitest";
import type { RenderQueueViewItem, RenderQueueViewState } from "../core/rendering/render-queue";
import * as desktop from "../desktop/api";
import * as renderJobs from "../render-queue/render-job-builder";
import { createInitialState, editorReducer } from "../state/editor-store";
import { AutomationApplicationService } from "./automation-service";
import { normalizeAiCommands } from "./command-normalizer";
import { executeScript } from "./script-runtime";

vi.mock("./edit-task", () => ({
  runEditTask: async (task: Parameters<typeof executeScript>[0] & { commands?: unknown[] }) =>
    task.commands
      ? { ...normalizeAiCommands(task.commands, task.project, task.currentTime), result: null }
      : executeScript({ ...task, code: task.code ?? "" }),
}));

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
    markSaved: () => {},
    loadProject: () => {},
  });
  const call = (name: string, args: Record<string, unknown> = {}, clientId = "agent") =>
    service.execute({ name, arguments: args, clientId, requestId: "request" }) as Promise<
      Record<string, unknown>
    >;
  return { call, service, state: () => state };
}

describe("low-round-trip external automation", () => {
  it("runs a script to completion and commits it in one call", async () => {
    const f = fixture();
    const result = await f.call("execute_aster_code", {
      baseRevision: 0,
      code: "return aster.compositions.active().layers.addText({ name: 'Lyric', text: 'hello' }).id;",
      commit: true,
      summary: "Add lyric",
    });
    expect(result).toMatchObject({
      state: "succeeded",
      committed: true,
      projectRevision: 1,
      operationCount: 1,
    });
    expect(f.state().history.past).toHaveLength(1);
    expect(f.state().project.compositions[0].layers.some((l) => l.id === result.result)).toBe(true);

    const noop = await f.call("execute_aster_code", {
      baseRevision: 1,
      code: "return 1;",
      commit: true,
    });
    expect(noop).toMatchObject({ state: "succeeded", committed: false, result: 1 });
    const failed = await f.call("execute_aster_code", {
      baseRevision: 1,
      code: "throw new Error('stop');",
      commit: true,
    });
    expect(failed).toMatchObject({
      state: "failed",
      committed: false,
      error: { code: "script_failed" },
    });
    expect(f.state().history.past).toHaveLength(1);
  });

  it("returns final execution state without polling and auto-submits on commit", async () => {
    const f = fixture();
    const run = await f.call("execute_aster_code", {
      baseRevision: 0,
      code: "const c = aster.compositions.active(); for (let i = 0; i < 40; i++) c.layers.addText({ text: 'u' + i }); return 40;",
    });
    expect(run).toMatchObject({ state: "succeeded", workspaceRevision: 1, result: 40 });
    const submitted = await f.call("submit_workspace", {
      workspaceId: run.workspaceId,
      workspaceRevision: 1,
      summary: "Units",
    });
    expect(submitted).toMatchObject({ operationCount: 40, operationTypes: { addLayer: 40 } });
    expect(submitted.operations).toBeUndefined();
    expect(JSON.stringify(submitted).length).toBeLessThan(1024);
    const second = await f.call("execute_aster_code", {
      baseRevision: 0,
      code: "aster.compositions.active().layers.addText({ text: 'more' });",
    });
    expect(
      await f.call("commit_workspace", {
        workspaceId: second.workspaceId,
        workspaceRevision: 1,
      }),
    ).toMatchObject({ committed: true, projectRevision: 1, operationCount: 1 });
  });

  it("keeps script modules across commits and clears them on reset", async () => {
    const f = fixture();
    expect(
      await f.call("put_script_module", {
        name: "pv-lib",
        code: "module.exports = { title: (c, text) => c.layers.addText({ name: 'T:' + text, text }).id };",
      }),
    ).toMatchObject({ stored: true, modules: [{ name: "pv-lib" }] });
    for (const [revision, text] of [
      [0, "one"],
      [1, "two"],
    ] as const)
      expect(
        await f.call("execute_aster_code", {
          baseRevision: revision,
          code: `return aster.require('pv-lib').title(aster.compositions.active(), '${text}');`,
          commit: true,
        }),
      ).toMatchObject({ committed: true, projectRevision: revision + 1 });
    expect(await f.call("get_script_api")).toMatchObject({ modules: ["pv-lib"] });
    await f.call("reset_session");
    expect(await f.call("list_script_modules")).toEqual({ modules: [] });
    expect(await f.call("list_script_modules", {}, "other")).toEqual({ modules: [] });
  });

  it("lists nested compositions and filters layers by name", async () => {
    const f = fixture();
    const created = await f.call("execute_aster_code", {
      baseRevision: 0,
      code: "const c = aster.compositions.active(); const ids = ['A','B'].map(n => c.layers.addText({ name: 'Lyric ' + n, text: n }).id); c.precompose(ids, 'SHOT_01');",
      commit: true,
    });
    expect(created).toMatchObject({ committed: true });
    const compositions = await f.call("query_project", { kind: "compositions" });
    expect(compositions.total).toBe(2);
    expect(compositions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SHOT_01", active: false, usedBy: [expect.any(String)] }),
      ]),
    );
    const nested = (compositions.items as Array<{ id: string; name: string }>).find(
      (item) => item.name === "SHOT_01",
    );
    expect(
      await f.call("query_project", {
        kind: "layers",
        compositionId: nested?.id,
        query: "lyric a",
      }),
    ).toMatchObject({ total: 1, items: [{ name: "Lyric A" }] });
  });

  it("finds commands and effects from paraphrased intent", async () => {
    const f = fixture();
    const search = await f.call("search_capabilities", { query: "delete composition" });
    expect(search.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "removeComposition" })]),
    );
    const blur = await f.call("search_capabilities", { query: "blur" });
    expect(blur.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "gaussian-blur" })]),
    );
    expect(await f.call("search_capabilities", { query: "" })).toMatchObject({
      index: { compositions: expect.arrayContaining(["removeComposition"]) },
    });
    const effects = await f.call("list_effects", { query: "gaussian blur", limit: 1 });
    expect(effects.items).toEqual([
      expect.objectContaining({
        type: "gaussian-blur",
        parameters: expect.arrayContaining([
          expect.objectContaining({ key: "radius", default: 18 }),
        ]),
      }),
    ]);
  });

  it("returns only the new render job and waits for it to finish", async () => {
    const f = fixture();
    const item = (id: string, status: RenderQueueViewItem["status"]): RenderQueueViewItem => ({
      manifest: {
        id,
        compositionId: "main",
        compositionName: "Main",
        projectRevision: 0,
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
        startFrame: 0,
        endFrameExclusive: 90,
        outputs: [
          {
            id: "out",
            kind: "mp4",
            destination: `D:/renders/${id}.mp4`,
            codec: "h264",
            bitrateMbps: 20,
            includeAudio: false,
          },
        ],
        priority: 0,
        createdAt: `2026-09-29T00:00:0${id.length % 10}Z`,
      },
      status,
      attempts: 0,
      progress: { completedFrames: status === "completed" ? 90 : 0, totalFrames: 90, elapsedMs: 0 },
    });
    const history = Array.from({ length: 20 }, (_, index) => item(`old-${index}`, "completed"));
    let state: RenderQueueViewState = { schemaVersion: 1, revision: 1, items: history };
    const listeners = new Set<(queue: RenderQueueViewState) => void>();
    const queue = {
      snapshot: vi.fn(async () => state),
      enqueue: vi.fn(async (manifest: { id: string }) => {
        state = { ...state, items: [...state.items, item(manifest.id, "queued")] };
        return state;
      }),
      onChanged: (listener: (queue: RenderQueueViewState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const build = vi
      .spyOn(renderJobs, "createRenderQueueJobAsync")
      .mockImplementation(
        async () =>
          ({ ...item("pending", "queued").manifest, id: undefined }) as unknown as Awaited<
            ReturnType<typeof renderJobs.createRenderQueueJobAsync>
          >,
      );
    const spy = vi
      .spyOn(desktop, "desktopRenderQueue")
      .mockReturnValue(queue as unknown as desktop.DesktopRenderQueue);
    try {
      const exported = await f.call("export_render", {
        path: "D:/renders/new.mp4",
        baseRevision: 0,
        outputKind: "mp4",
      });
      expect(exported).toMatchObject({ job: { status: "queued" }, activeJobs: 1 });
      expect(exported.queue).toBeUndefined();
      const jobId = exported.jobId as string;
      expect(await f.call("get_render_queue", { limit: 3 })).toMatchObject({
        total: 21,
        active: 1,
      });
      expect(await f.call("get_render_queue", { jobId })).toMatchObject({
        jobId,
        status: "queued",
      });
      const waiting = f.call("wait_render", { jobId, timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = {
        ...state,
        items: state.items.map((entry) =>
          entry.manifest.id === jobId ? { ...item(jobId, "completed") } : entry,
        ),
      };
      for (const listener of listeners) listener(state);
      expect(await waiting).toMatchObject({
        jobId,
        status: "completed",
        outputs: [{ destination: `D:/renders/${jobId}.mp4` }],
      });
    } finally {
      build.mockRestore();
      spy.mockRestore();
    }
  });
});
