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

class GatedHostFactory extends FakeHostFactory {
  readonly started = deferred<void>();
  readonly release = deferred<void>();

  override async launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle> {
    const worker = await super.launch(item, leaseId, report);
    this.started.resolve(undefined);
    await this.release.promise;
    return worker;
  }
}

class GatedFailureFactory implements RenderQueueHostFactory {
  readonly started = deferred<void>();
  readonly release = deferred<void>();

  async launch(): Promise<RenderQueueHostHandle> {
    this.started.resolve(undefined);
    await this.release.promise;
    throw new Error("authorization failed after cancel");
  }
}

class GatedDisposeFactory extends FakeHostFactory {
  readonly disposalStarted = deferred<void>();
  readonly releaseDisposal = deferred<void>();

  override async launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle> {
    const worker = (await super.launch(item, leaseId, report)) as FakeWorker;
    let disposing = false;
    worker.dispose = async () => {
      // Mirrors the production worker: it marks itself disposed before awaiting cleanup, so a
      // duplicate call is idempotent but does not await the first call's in-flight resources.
      if (disposing) return;
      disposing = true;
      this.disposalStarted.resolve(undefined);
      await this.releaseDisposal.promise;
      worker.disposed = true;
    };
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

  it("does not reuse a cancelled worker slot until the hidden host finishes cleanup", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "cancel-before-cleanup" });
    await context.manager.enqueue({ ...job, id: "wait-for-cleanup" });
    await context.manager.startScheduler(hosts, 1);
    const cancelled = hosts.workers[0];
    await cancelled.report({
      type: "prepared",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });

    await context.manager.command({ type: "cancel", jobId: cancelled.jobId });
    expect(
      context.manager.snapshot().items.find((item) => item.manifest.id === cancelled.jobId)?.status,
    ).toBe("cancelled");
    expect(context.manager.activeHostCount).toBe(1);
    expect(hosts.workers).toHaveLength(1);

    await cancelled.report({
      type: "cancelled",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });
    expect(cancelled.disposed).toBe(true);
    expect(hosts.workers).toHaveLength(2);
    expect(hosts.workers[1]?.item.manifest.id).not.toBe(cancelled.jobId);
    expect(context.manager.activeHostCount).toBe(1);
  });

  it("retries immediately without letting the cancelled lease reject or block its replacement", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "cancel-and-retry" });
    await context.manager.startScheduler(hosts, 1);
    const cancelled = hosts.workers[0];
    await cancelled.report({
      type: "prepared",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });

    await context.manager.command({ type: "cancel", jobId: cancelled.jobId });
    await context.manager.command({ type: "retry", jobId: cancelled.jobId });
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(context.manager.activeHostCount).toBe(1);
    expect(hosts.workers).toHaveLength(1);

    await expect(
      cancelled.report({
        type: "progress",
        jobId: cancelled.jobId,
        leaseId: cancelled.leaseId,
        progress: { completedFrames: 29, totalFrames: 30, elapsedMs: 900 },
      }),
    ).resolves.toBeUndefined();
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      progress: { completedFrames: 0 },
    });

    await expect(
      cancelled.report({
        type: "cancelled",
        jobId: cancelled.jobId,
        leaseId: cancelled.leaseId,
      }),
    ).resolves.toBeUndefined();
    expect(cancelled.disposed).toBe(true);
    expect(hosts.workers).toHaveLength(2);
    expect(hosts.workers[1]?.leaseId).not.toBe(cancelled.leaseId);
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "preparing",
      attempts: 2,
      workerLeaseId: hosts.workers[1]?.leaseId,
    });
  });

  it("never overwrites a draining lease with an immediate retry at parallel concurrency", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "parallel-cancel-retry" });
    await context.manager.startScheduler(hosts, 2);
    const cancelled = hosts.workers[0];
    await cancelled.report({
      type: "prepared",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });

    await context.manager.command({ type: "cancel", jobId: cancelled.jobId });
    await context.manager.command({ type: "retry", jobId: cancelled.jobId });

    expect(hosts.workers).toHaveLength(1);
    expect(context.manager.activeHostCount).toBe(1);
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "queued",
      attempts: 1,
    });

    await cancelled.report({
      type: "cancelled",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });

    expect(cancelled.disposed).toBe(true);
    expect(hosts.workers).toHaveLength(2);
    expect(hosts.workers[1]?.leaseId).not.toBe(cancelled.leaseId);
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "preparing",
      attempts: 2,
      workerLeaseId: hosts.workers[1]?.leaseId,
    });
  });

  it("keeps a paused lease counted until asynchronous resource disposal finishes", async () => {
    const context = await manager();
    const hosts = new GatedDisposeFactory();
    await context.manager.enqueue({ ...job, id: "pause-dispose-resume" });
    await context.manager.startScheduler(hosts, 2);
    const paused = hosts.workers[0];
    await paused.report({ type: "prepared", jobId: paused.jobId, leaseId: paused.leaseId });
    await context.manager.command({ type: "pause", jobId: paused.jobId });

    const acknowledgement = paused.report({
      type: "paused",
      jobId: paused.jobId,
      leaseId: paused.leaseId,
    });
    await hosts.disposalStarted.promise;
    expect(context.manager.snapshot().items[0]?.status).toBe("paused");
    expect(context.manager.activeHostCount).toBe(1);

    await context.manager.command({ type: "resume", jobId: paused.jobId });
    expect(hosts.workers).toHaveLength(1);
    expect(context.manager.activeHostCount).toBe(1);

    hosts.releaseDisposal.resolve(undefined);
    await acknowledgement;
    expect(paused.disposed).toBe(true);
    expect(hosts.workers).toHaveLength(2);
    expect(context.manager.snapshot().items[0]).toMatchObject({
      status: "preparing",
      attempts: 2,
      workerLeaseId: hosts.workers[1]?.leaseId,
    });
  });

  it("awaits an in-flight host retirement before shutdown exits", async () => {
    const context = await manager();
    const hosts = new GatedDisposeFactory();
    await context.manager.enqueue({ ...job, id: "shutdown-during-dispose" });
    await context.manager.startScheduler(hosts);
    const completed = hosts.workers[0];
    await completed.report({
      type: "prepared",
      jobId: completed.jobId,
      leaseId: completed.leaseId,
    });

    const acknowledgement = completed.report({
      type: "completed",
      jobId: completed.jobId,
      leaseId: completed.leaseId,
    });
    await hosts.disposalStarted.promise;
    let shutdownSettled = false;
    const shutdown = context.manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    hosts.releaseDisposal.resolve(undefined);
    await Promise.all([acknowledgement, shutdown]);
    expect(completed.disposed).toBe(true);
    expect(shutdownSettled).toBe(true);
  });

  it("keeps eight-slot cancel, retry, and remove churn bounded by live leases", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    for (let index = 0; index < 16; index += 1)
      await context.manager.enqueue({ ...job, id: `churn-${index.toString().padStart(2, "0")}` });
    await context.manager.startScheduler(hosts, 8);
    expect(hosts.workers).toHaveLength(8);

    const retiring = hosts.workers.slice(0, 4);
    await Promise.all(
      hosts.workers.map((worker) =>
        worker.report({ type: "prepared", jobId: worker.jobId, leaseId: worker.leaseId }),
      ),
    );
    for (const worker of retiring)
      await context.manager.command({ type: "cancel", jobId: worker.jobId });
    for (const worker of retiring.slice(0, 2))
      await context.manager.command({ type: "retry", jobId: worker.jobId });
    for (const worker of retiring.slice(2))
      await context.manager.command({ type: "remove", jobId: worker.jobId });

    expect(context.manager.activeHostCount).toBe(8);
    expect(hosts.workers).toHaveLength(8);
    await Promise.all(
      retiring.map((worker) =>
        worker.report({ type: "cancelled", jobId: worker.jobId, leaseId: worker.leaseId }),
      ),
    );

    expect(retiring.every((worker) => worker.disposed)).toBe(true);
    expect(context.manager.activeHostCount).toBe(8);
    expect(hosts.workers).toHaveLength(12);
    expect(context.manager.snapshot().items.map((item) => item.manifest.id)).not.toContain(
      retiring[2]?.jobId,
    );
    expect(context.manager.snapshot().items.map((item) => item.manifest.id)).not.toContain(
      retiring[3]?.jobId,
    );
    for (const worker of retiring.slice(0, 2)) {
      const replacement = hosts.workers.find(
        (candidate) => candidate.jobId === worker.jobId && candidate !== worker,
      );
      expect(replacement?.leaseId).toBeDefined();
      expect(replacement?.leaseId).not.toBe(worker.leaseId);
    }
  });

  it("removes immediately while a cancelled lease failure still releases the worker", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "cancel-and-remove" });
    await context.manager.startScheduler(hosts, 1);
    const cancelled = hosts.workers[0];
    await cancelled.report({
      type: "prepared",
      jobId: cancelled.jobId,
      leaseId: cancelled.leaseId,
    });

    await context.manager.command({ type: "cancel", jobId: cancelled.jobId });
    await context.manager.command({ type: "remove", jobId: cancelled.jobId });
    expect(context.manager.snapshot().items).toEqual([]);
    expect(context.manager.activeHostCount).toBe(1);

    await expect(
      cancelled.report({
        type: "failed",
        jobId: cancelled.jobId,
        leaseId: cancelled.leaseId,
        error: { code: "cancel_drain_failed", message: "encoder stopped while cancelling" },
      }),
    ).resolves.toBeUndefined();
    expect(cancelled.disposed).toBe(true);
    expect(context.manager.activeHostCount).toBe(0);
    expect(context.manager.snapshot().items).toEqual([]);
  });

  it("still rejects an unsolicited cancelled report from an active lease", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "unsolicited-cancel" });
    await context.manager.startScheduler(hosts, 1);
    const worker = hosts.workers[0];

    await expect(
      worker.report({ type: "cancelled", jobId: worker.jobId, leaseId: worker.leaseId }),
    ).rejects.toThrow("without a cancel request");
    expect(worker.disposed).toBe(false);
    expect(context.manager.activeHostCount).toBe(1);
  });

  it("marks cancellation before a host can synchronously acknowledge control", async () => {
    const context = await manager();
    const hosts = new FakeHostFactory();
    await context.manager.enqueue({ ...job, id: "synchronous-cancel" });
    await context.manager.startScheduler(hosts, 1);
    const worker = hosts.workers[0];
    await worker.report({ type: "prepared", jobId: worker.jobId, leaseId: worker.leaseId });
    worker.control = async (command) => {
      worker.controls.push(command);
      await worker.report({ type: "cancelled", jobId: worker.jobId, leaseId: worker.leaseId });
    };

    await expect(
      context.manager.command({ type: "cancel", jobId: worker.jobId }),
    ).resolves.toMatchObject({ items: [{ status: "cancelled" }] });
    expect(worker.controls).toEqual(["cancel"]);
    expect(worker.disposed).toBe(true);
    expect(context.manager.activeHostCount).toBe(0);
  });

  it("disposes a launch whose worker lease was cancelled during media preparation", async () => {
    const context = await manager();
    const hosts = new GatedHostFactory();
    await context.manager.enqueue({ ...job, id: "cancel-during-launch" });
    const scheduler = context.manager.startScheduler(hosts, 1);
    await hosts.started.promise;

    const cancellation = context.manager.command({
      type: "cancel",
      jobId: "cancel-during-launch",
    });
    await vi.waitFor(() => expect(context.manager.snapshot().items[0]?.status).toBe("cancelled"));
    hosts.release.resolve(undefined);
    await Promise.all([scheduler, cancellation]);

    expect(hosts.workers[0]?.controls).toEqual(["cancel"]);
    expect(hosts.workers[0]?.disposed).toBe(true);
    expect(context.manager.activeHostCount).toBe(0);
  });

  it("does not publish launch failure through a lease retired by cancellation", async () => {
    const context = await manager();
    const hosts = new GatedFailureFactory();
    await context.manager.enqueue({ ...job, id: "cancel-before-launch-failure" });
    const scheduler = context.manager.startScheduler(hosts, 1);
    await hosts.started.promise;
    const cancellation = context.manager.command({
      type: "cancel",
      jobId: "cancel-before-launch-failure",
    });
    await vi.waitFor(() => expect(context.manager.snapshot().items[0]?.status).toBe("cancelled"));

    hosts.release.resolve(undefined);
    await Promise.all([scheduler, cancellation]);
    const item = context.manager.snapshot().items[0];
    expect(item?.status).toBe("cancelled");
    expect(item).not.toHaveProperty("error");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
