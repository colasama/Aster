import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderQueueItem } from "../src/core/render-queue";
import {
  type RenderHostReport,
  type RenderQueueHostFactory,
  type RenderQueueHostHandle,
  RenderQueueManager,
} from "./render-queue-manager";
import { RenderQueueStore } from "./render-queue-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function manager() {
  const root = await mkdtemp(join(tmpdir(), "aster-render-manager-"));
  roots.push(root);
  const store = new RenderQueueStore(root);
  await store.initialize();
  const publish = vi.fn();
  return { manager: new RenderQueueManager(store, publish), publish };
}

interface FakeWorker extends RenderQueueHostHandle {
  controls: Array<"pause" | "cancel">;
  disposed: boolean;
  item: RenderQueueItem;
  report: (event: RenderHostReport) => Promise<void>;
}

class FakeHostFactory implements RenderQueueHostFactory {
  readonly workers: FakeWorker[] = [];

  async launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle> {
    const worker: FakeWorker = {
      jobId: item.manifest.id,
      leaseId,
      item,
      report,
      controls: [],
      disposed: false,
      control(command) {
        this.controls.push(command);
      },
      dispose() {
        this.disposed = true;
      },
    };
    this.workers.push(worker);
    return worker;
  }
}

const job = {
  id: "queued-job",
  compositionId: "composition",
  compositionName: "Main",
  projectRevision: 4,
  projectSnapshot: '{"schemaVersion":4}',
  width: 1280,
  height: 720,
  frameRate: { numerator: 30, denominator: 1 },
  startFrame: 0,
  endFrameExclusive: 30,
  outputs: [
    {
      id: "video",
      kind: "mp4",
      destination: "C:\\renders\\main.mp4",
      codec: "h264",
      bitrateMbps: 16,
      includeAudio: true,
    },
  ],
};

describe("RenderQueueManager", () => {
  it("validates, persists, and publishes renderer commands", async () => {
    const context = await manager();
    const queued = await context.manager.enqueue(job);
    expect(queued.items[0]).toMatchObject({ status: "queued", manifest: { id: "queued-job" } });
    const paused = await context.manager.command({ type: "pause", jobId: "queued-job" });
    expect(paused.items[0]?.status).toBe("paused");
    const resumed = await context.manager.command({ type: "resume", jobId: "queued-job" });
    expect(resumed.items[0]?.status).toBe("queued");
    const prioritized = await context.manager.command({
      type: "reprioritize",
      jobId: "queued-job",
      priority: 42,
    });
    expect(prioritized.items[0]?.manifest.priority).toBe(42);
    const removed = await context.manager.command({ type: "remove", jobId: "queued-job" });
    expect(removed.items).toEqual([]);
    expect(context.publish).toHaveBeenCalledTimes(5);
  });

  it("rejects malformed input at the process boundary", async () => {
    const context = await manager();
    await expect(context.manager.enqueue({})).rejects.toThrow();
    await expect(context.manager.command({ type: "delete", jobId: "job" })).rejects.toThrow(
      "command type",
    );
    await expect(
      context.manager.command({ type: "reprioritize", jobId: "job", priority: 1.5 }),
    ).rejects.toThrow("priority");
    await expect(
      context.manager.report({
        type: "completed",
        jobId: "job",
        leaseId: "lease",
        unexpected: true,
      }),
    ).rejects.toThrow("unknown fields");
  });

  it("claims one immutable job and advances through preparing, rendering, and completion", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue(job);
    await context.manager.startScheduler(hosts);

    const worker = hosts.workers[0];
    expect(worker.item.manifest.projectSnapshot).toBe(job.projectSnapshot);
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "preparing",
      attempts: 1,
      workerLeaseId: worker.leaseId,
    });

    await worker.report({
      type: "prepared",
      jobId: worker.jobId,
      leaseId: worker.leaseId,
    });
    await worker.report({
      type: "progress",
      jobId: worker.jobId,
      leaseId: worker.leaseId,
      progress: { completedFrames: 12, totalFrames: 30, elapsedMs: 400 },
    });
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "rendering",
      progress: { completedFrames: 12 },
    });

    await worker.report({
      type: "completed",
      jobId: worker.jobId,
      leaseId: worker.leaseId,
    });
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "completed",
      progress: { completedFrames: 30 },
    });
    expect(context.manager.snapshot().items[0]).not.toHaveProperty("workerLeaseId");
    expect(worker.disposed).toBe(true);
  });

  it("rejects stale leases and fails a crashed render host", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue(job);
    await context.manager.startScheduler(hosts);
    const worker = hosts.workers[0];

    await expect(
      context.manager.report({
        type: "prepared",
        jobId: worker.jobId,
        leaseId: "expired-lease",
      }),
    ).rejects.toThrow("Stale");
    await worker.report({
      type: "failed",
      jobId: worker.jobId,
      leaseId: worker.leaseId,
      error: { code: "render_host_crashed", message: "GPU process exited" },
    });

    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "failed",
      error: { code: "render_host_crashed" },
    });
    expect(context.manager.snapshot().items[0]).not.toHaveProperty("workerLeaseId");
  });

  it("applies pause and cancel only after the active host acknowledges a frame boundary", async () => {
    const pauseContext = await manager();
    const pauseHosts = new FakeHostFactory();
    await pauseContext.manager.enqueue(job);
    await pauseContext.manager.startScheduler(pauseHosts);
    const pausedWorker = pauseHosts.workers[0];
    await pausedWorker.report({
      type: "prepared",
      jobId: pausedWorker.jobId,
      leaseId: pausedWorker.leaseId,
    });

    await pauseContext.manager.command({ type: "pause", jobId: pausedWorker.jobId });
    expect(pauseContext.manager.snapshot().items[0]?.status).toBe("pauseRequested");
    expect(pausedWorker.controls).toEqual(["pause"]);
    await pausedWorker.report({
      type: "paused",
      jobId: pausedWorker.jobId,
      leaseId: pausedWorker.leaseId,
    });
    expect(pauseContext.manager.snapshot().items[0]?.status).toBe("paused");

    const cancelContext = await manager();
    const cancelHosts = new FakeHostFactory();
    await cancelContext.manager.enqueue({ ...job, id: "cancel-job" });
    await cancelContext.manager.startScheduler(cancelHosts);
    const cancelledWorker = cancelHosts.workers[0];
    await cancelledWorker.report({
      type: "prepared",
      jobId: cancelledWorker.jobId,
      leaseId: cancelledWorker.leaseId,
    });
    await cancelContext.manager.command({ type: "cancel", jobId: cancelledWorker.jobId });
    expect(cancelContext.manager.snapshot().items[0]?.status).toBe("cancelled");
    expect(cancelledWorker.controls).toEqual(["cancel"]);
    await cancelledWorker.report({
      type: "cancelled",
      jobId: cancelledWorker.jobId,
      leaseId: cancelledWorker.leaseId,
    });
    expect(cancelledWorker.disposed).toBe(true);
  });

  it("keeps the default host count at one and fills an explicitly larger concurrency", async () => {
    const serialContext = await manager();
    const serialHosts = new FakeHostFactory();
    await serialContext.manager.enqueue({ ...job, id: "serial-a" });
    await serialContext.manager.enqueue({ ...job, id: "serial-b" });
    await serialContext.manager.startScheduler(serialHosts);
    expect(serialHosts.workers).toHaveLength(1);
    const first = serialHosts.workers[0];
    await first.report({ type: "prepared", jobId: first.jobId, leaseId: first.leaseId });
    await first.report({ type: "completed", jobId: first.jobId, leaseId: first.leaseId });
    expect(serialHosts.workers).toHaveLength(2);

    const parallelContext = await manager();
    const parallelHosts = new FakeHostFactory();
    await parallelContext.manager.enqueue({ ...job, id: "parallel-a" });
    await parallelContext.manager.enqueue({ ...job, id: "parallel-b" });
    await parallelContext.manager.startScheduler(parallelHosts, 2);
    expect(parallelHosts.workers).toHaveLength(2);
    expect(parallelContext.manager.activeHostCount).toBe(2);
  });
});
