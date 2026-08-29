import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderQueueManager } from "./render-queue-manager";
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
    expect(context.publish).toHaveBeenCalledTimes(4);
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
  });
});
