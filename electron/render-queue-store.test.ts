import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimRenderJob,
  enqueueRenderJob,
  markRenderJobRunning,
  type RenderQueueState,
} from "../src/core/render-queue";
import { RenderQueueStore } from "./render-queue-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function enqueue(state: RenderQueueState, id: string): RenderQueueState {
  return enqueueRenderJob(state, {
    id,
    compositionId: "composition",
    compositionName: "Main",
    projectRevision: 1,
    projectSnapshot: '{"schemaVersion":4}',
    width: 1920,
    height: 1080,
    frameRate: { numerator: 24, denominator: 1 },
    startFrame: 0,
    endFrameExclusive: 24,
    outputs: [
      {
        id: `${id}-output`,
        kind: "pngSequence",
        destination: join("renders", id),
        fileNamePattern: "frame_[######].png",
      },
    ],
  });
}

async function temporaryStore(): Promise<{ root: string; store: RenderQueueStore }> {
  const root = await mkdtemp(join(tmpdir(), "aster-render-queue-"));
  roots.push(root);
  return { root, store: new RenderQueueStore(root) };
}

describe("RenderQueueStore", () => {
  it("serializes updates and restores the latest validated revision", async () => {
    const { root, store } = await temporaryStore();
    await store.initialize();
    const first = store.update((state) => enqueue(state, "one"));
    const second = store.update((state) => enqueue(state, "two"));
    await Promise.all([first, second]);

    const restored = new RenderQueueStore(root);
    expect(await restored.initialize()).toMatchObject({ resetInvalid: false });
    expect(restored.snapshot().items.map((item) => item.manifest.id)).toEqual(["one", "two"]);
    expect(restored.snapshot().revision).toBe(2);
  });

  it("recovers a valid backup when the primary queue is corrupted", async () => {
    const { root, store } = await temporaryStore();
    await store.initialize();
    await store.update((state) => enqueue(state, "safe"));
    await store.update((state) => enqueue(state, "latest"));
    await writeFile(join(root, "render-queue.json"), "{", "utf8");

    const restored = new RenderQueueStore(root);
    expect(await restored.initialize()).toMatchObject({ recoveredBackup: true });
    expect(restored.snapshot().items.map((item) => item.manifest.id)).toEqual(["safe"]);
  });

  it("fails interrupted leases and preserves progress for diagnostics", async () => {
    const { root, store } = await temporaryStore();
    await store.initialize();
    await store.update((state) => {
      const queued = enqueue(state, "interrupted");
      const claimed = claimRenderJob(queued, "interrupted", "dead-host");
      return markRenderJobRunning(claimed, "interrupted", "dead-host");
    });

    const restored = new RenderQueueStore(root);
    expect(await restored.initialize(new Date("2026-08-30T04:00:00Z"))).toMatchObject({
      interruptedJobs: 1,
    });
    expect(restored.snapshot().items[0]).toMatchObject({
      status: "failed",
      workerLeaseId: undefined,
      finishedAt: "2026-08-30T04:00:00.000Z",
      error: { code: "render_host_interrupted" },
    });
  });

  it("never overwrites a queue from a newer application", async () => {
    const { root, store } = await temporaryStore();
    const path = join(root, "render-queue.json");
    const future = '{"schemaVersion":99,"future":"preserve"}';
    await writeFile(path, future, "utf8");
    expect(await store.initialize()).toMatchObject({ incompatibleFuture: true });
    await expect(store.update((state) => state)).rejects.toThrow("newer build");
    expect(await readFile(path, "utf8")).toBe(future);
  });
});
