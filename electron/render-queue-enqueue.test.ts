import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderMediaSnapshotStore } from "./render-media-snapshot-store";
import {
  captureAuthorizedRenderQueueInput,
  identifyRenderQueueInput,
} from "./render-queue-enqueue";
import { RenderQueueManager } from "./render-queue-manager";
import { RenderQueueStore } from "./render-queue-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("render queue enqueue boundary", () => {
  it("assigns one durable ID for media capture and every queue lifecycle command", async () => {
    const root = await temporaryRoot();
    const queueStore = new RenderQueueStore(join(root, "queue"));
    await queueStore.initialize();
    const manager = new RenderQueueManager(queueStore, vi.fn());
    const mediaSnapshots = new RenderMediaSnapshotStore(join(root, "media"));
    const identified = identifyRenderQueueInput(jobWithoutId(), () => "generated-job");
    const prepared = await captureAuthorizedRenderQueueInput(identified, mediaSnapshots, new Map());

    expect(prepared.jobId).toBe("generated-job");
    expect(prepared.input.id).toBe("generated-job");
    expect((await stat(mediaSnapshots.directoryFor("generated-job"))).isDirectory()).toBe(true);

    let state = await manager.enqueue(prepared.input);
    expect(state.items[0]).toMatchObject({ status: "queued", manifest: { id: "generated-job" } });
    mediaSnapshots.commit(prepared.jobId);
    state = await manager.command({ type: "pause", jobId: prepared.jobId });
    expect(state.items[0]?.status).toBe("paused");
    state = await manager.command({ type: "resume", jobId: prepared.jobId });
    expect(state.items[0]?.status).toBe("queued");
    state = await manager.command({ type: "cancel", jobId: prepared.jobId });
    expect(state.items[0]?.status).toBe("cancelled");
    state = await manager.command({ type: "retry", jobId: prepared.jobId });
    expect(state.items[0]?.status).toBe("queued");
    state = await manager.command({ type: "cancel", jobId: prepared.jobId });
    state = await manager.command({ type: "remove", jobId: prepared.jobId });
    expect(state.items).toEqual([]);
  });

  it("normalizes explicit IDs to the core queue bound before snapshot capture", () => {
    expect(identifyRenderQueueInput(jobWithoutId("  explicit-job  ")).jobId).toBe("explicit-job");
    expect(() => identifyRenderQueueInput(jobWithoutId(""))).toThrow(
      "Render queue job ID is invalid",
    );
    expect(() => identifyRenderQueueInput(jobWithoutId("x".repeat(129)))).toThrow(
      "Render queue job ID is invalid",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aster-render-enqueue-"));
  roots.push(root);
  return root;
}

function jobWithoutId(id?: string): Record<string, unknown> {
  return {
    ...(id === undefined ? {} : { id }),
    compositionId: "composition",
    compositionName: "Main 4K",
    projectRevision: 1,
    projectSnapshot: '{"schemaVersion":9}',
    renderMediaSnapshot: '{"version":1,"entries":[],"payloads":[]}',
    width: 3840,
    height: 2160,
    frameRate: { numerator: 24, denominator: 1 },
    startFrame: 0,
    endFrameExclusive: 24,
    outputs: [
      {
        id: "video",
        kind: "mp4",
        destination: "C:\\renders\\main.mp4",
        codec: "h264",
        bitrateMbps: 20,
        includeAudio: false,
      },
    ],
  };
}
