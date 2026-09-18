import { describe, expect, it } from "vitest";
import {
  acknowledgeRenderPaused,
  cancelRenderJob,
  claimRenderJob,
  completeRenderJob,
  createRenderQueue,
  enqueueRenderJob,
  failRenderJob,
  markRenderJobRunning,
  migrateRenderQueue,
  nextRunnableRenderJobs,
  recoverInterruptedRenderJobs,
  removeRenderJob,
  renderQueueView,
  reprioritizeRenderJob,
  requestRenderPause,
  resumeRenderJob,
  retryRenderJob,
  serializeRenderQueue,
  updateRenderProgress,
} from "./render-queue";

function input(id: string, priority = 0) {
  return {
    id,
    compositionId: "composition-1",
    compositionName: "Main",
    projectRevision: 7,
    projectSnapshot: '{"schemaVersion":3}',
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    startFrame: 10,
    endFrameExclusive: 20,
    outputs: [
      {
        id: `${id}-output`,
        kind: "mp4" as const,
        destination: `C:\\renders\\${id}.mp4`,
        codec: "h264" as const,
        bitrateMbps: 24,
        includeAudio: true,
      },
    ],
    priority,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("render queue", () => {
  it("retains captured AA through persistence and defaults legacy jobs to off", () => {
    const legacy = enqueueRenderJob(createRenderQueue(), input("legacy"));
    expect(legacy.items[0].manifest.antiAliasing).toBe("off");
    const state = enqueueRenderJob(createRenderQueue(), { ...input("aa"), antiAliasing: "ssaa2x" });
    expect(
      migrateRenderQueue(JSON.parse(serializeRenderQueue(state))).items[0].manifest.antiAliasing,
    ).toBe("ssaa2x");
    expect(() =>
      enqueueRenderJob(createRenderQueue(), {
        ...input("bad-aa"),
        antiAliasing: "unknown" as "fxaa",
      }),
    ).toThrow("antiAliasing");
  });
  it("captures immutable manifests and rejects invalid snapshot/output bounds", () => {
    const state = enqueueRenderJob(createRenderQueue(), input("job-1"));
    expect(state).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          status: "queued",
          progress: { completedFrames: 0, totalFrames: 10 },
          manifest: { id: "job-1", projectRevision: 7 },
        },
      ],
    });
    expect(() => enqueueRenderJob(state, input("job-1"))).toThrow("already contains");
    expect(() =>
      enqueueRenderJob(createRenderQueue(), { ...input("bad"), projectSnapshot: "{" }),
    ).toThrow("valid JSON");
    expect(() =>
      enqueueRenderJob(createRenderQueue(), { ...input("empty"), endFrameExclusive: 10 }),
    ).toThrow("empty frame range");
  });

  it("uses worker leases to reject stale progress and preserves monotonic frames", () => {
    let state = enqueueRenderJob(createRenderQueue(), input("job"));
    state = claimRenderJob(state, "job", "lease-1", new Date("2026-08-30T00:00:01Z"));
    state = markRenderJobRunning(state, "job", "lease-1");
    state = updateRenderProgress(state, "job", "lease-1", {
      completedFrames: 4,
      totalFrames: 10,
      elapsedMs: 100,
      estimatedRemainingMs: 150,
    });
    expect(state.items[0]?.progress.completedFrames).toBe(4);
    expect(() =>
      updateRenderProgress(state, "job", "stale", {
        completedFrames: 5,
        totalFrames: 10,
        elapsedMs: 120,
      }),
    ).toThrow("Stale worker lease");
    expect(() =>
      updateRenderProgress(state, "job", "lease-1", {
        completedFrames: 3,
        totalFrames: 10,
        elapsedMs: 130,
      }),
    ).toThrow("move backwards");
    expect(() =>
      updateRenderProgress(state, "job", "lease-1", {
        completedFrames: 4,
        totalFrames: 10,
        elapsedMs: 99,
      }),
    ).toThrow("elapsed time");
    state = completeRenderJob(state, "job", "lease-1", new Date("2026-08-30T00:00:02Z"));
    expect(state.items[0]).toMatchObject({
      status: "completed",
      progress: { completedFrames: 10, estimatedRemainingMs: 0 },
    });
  });

  it("pauses at a worker boundary, resumes, fails, and retries cleanly", () => {
    let state = enqueueRenderJob(createRenderQueue(), input("job"));
    state = claimRenderJob(state, "job", "lease-1");
    state = markRenderJobRunning(state, "job", "lease-1");
    state = updateRenderProgress(state, "job", "lease-1", {
      completedFrames: 4,
      totalFrames: 10,
      elapsedMs: 120,
      estimatedRemainingMs: 180,
    });
    state = requestRenderPause(state, "job");
    expect(state.items[0]?.status).toBe("pauseRequested");
    state = acknowledgeRenderPaused(state, "job", "lease-1");
    expect(state.items[0]).toMatchObject({
      status: "paused",
      workerLeaseId: "lease-1",
      progress: { completedFrames: 4, elapsedMs: 120, estimatedRemainingMs: 180 },
    });
    state = resumeRenderJob(state, "job");
    expect(state.items[0]).toMatchObject({
      status: "rendering",
      workerLeaseId: "lease-1",
      progress: { completedFrames: 4, elapsedMs: 120, estimatedRemainingMs: 180 },
    });
    state = failRenderJob(
      state,
      "job",
      "lease-1",
      { code: "encoder", message: "Encoder exited", correlationId: "correlation" },
      new Date("2026-08-30T00:00:03Z"),
    );
    expect(state.items[0]).toMatchObject({ status: "failed", attempts: 1 });
    state = retryRenderJob(state, "job");
    expect(state.items[0]).toMatchObject({
      status: "queued",
      progress: { completedFrames: 0 },
      error: undefined,
    });
    state = cancelRenderJob(state, "job");
    expect(state.items[0]?.status).toBe("cancelled");
    expect(cancelRenderJob(state, "job")).toBe(state);
  });

  it("schedules deterministic priority order within the available concurrency", () => {
    let state = createRenderQueue();
    state = enqueueRenderJob(state, input("old-low", 1));
    state = enqueueRenderJob(state, { ...input("high", 8), createdAt: "2026-08-30T00:00:02Z" });
    state = enqueueRenderJob(state, { ...input("old-high", 8), createdAt: "2026-08-30T00:00:01Z" });
    expect(nextRunnableRenderJobs(state, 2).map((item) => item.manifest.id)).toEqual([
      "old-high",
      "high",
    ]);
    state = claimRenderJob(state, "high", "lease");
    expect(nextRunnableRenderJobs(state, 2).map((item) => item.manifest.id)).toEqual(["old-high"]);
    state = reprioritizeRenderJob(state, "old-low", 10);
    expect(nextRunnableRenderJobs(state, 2)[0]?.manifest.id).toBe("old-low");
  });

  it("roundtrips and strictly validates persisted queue state", () => {
    const state = enqueueRenderJob(createRenderQueue(), input("job"));
    expect(migrateRenderQueue(JSON.parse(serializeRenderQueue(state)))).toEqual(state);
    expect(migrateRenderQueue({ items: [] })).toEqual(createRenderQueue());
    expect(() => migrateRenderQueue({ schemaVersion: 99, items: [] })).toThrow("newer");
    expect(() =>
      migrateRenderQueue({
        ...state,
        items: [state.items[0], state.items[0]],
      }),
    ).toThrow("Duplicate render job");
  });

  it("invalidates interrupted worker leases without publishing partial output", () => {
    let state = enqueueRenderJob(createRenderQueue(), input("job"));
    state = claimRenderJob(state, "job", "dead-worker");
    state = markRenderJobRunning(state, "job", "dead-worker");
    state = updateRenderProgress(state, "job", "dead-worker", {
      completedFrames: 7,
      totalFrames: 10,
      elapsedMs: 700,
    });
    state = requestRenderPause(state, "job");
    state = acknowledgeRenderPaused(state, "job", "dead-worker");
    const recovered = recoverInterruptedRenderJobs(state, new Date("2026-08-30T00:01:00Z"));
    expect(recovered.items[0]).toMatchObject({
      status: "failed",
      workerLeaseId: undefined,
      finishedAt: "2026-08-30T00:01:00.000Z",
      progress: { completedFrames: 7 },
      error: { code: "render_host_interrupted" },
    });
    expect(recoverInterruptedRenderJobs(recovered)).toBe(recovered);
    const retried = retryRenderJob(recovered, "job");
    expect(retried.items[0]).toMatchObject({
      status: "queued",
      progress: { completedFrames: 0 },
      error: undefined,
    });
  });

  it("removes inactive jobs but never drops an active worker lease", () => {
    let state = enqueueRenderJob(createRenderQueue(), input("job"));
    const empty = removeRenderJob(state, "job");
    expect(empty.items).toEqual([]);
    expect(empty.revision).toBe(state.revision + 1);
    expect(() => removeRenderJob(empty, "job")).toThrow("Unknown render job");

    state = enqueueRenderJob(createRenderQueue(), input("active"));
    state = claimRenderJob(state, "active", "lease");
    expect(() => removeRenderJob(state, "active")).toThrow("cannot transition");
  });

  it("projects progress without sending immutable project snapshots to the renderer", () => {
    let state = enqueueRenderJob(createRenderQueue(), input("job"));
    state = claimRenderJob(state, "job", "private-lease");
    const view = renderQueueView(state);
    expect(view).toMatchObject({ revision: state.revision, items: [{ manifest: { id: "job" } }] });
    expect(view.items[0]?.manifest).not.toHaveProperty("projectSnapshot");
    expect(view.items[0]?.manifest).not.toHaveProperty("renderMediaSnapshot");
    expect(view.items[0]).not.toHaveProperty("workerLeaseId");
    expect(view.items[0]?.manifest.outputs).not.toBe(state.items[0]?.manifest.outputs);
  });
});
