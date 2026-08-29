import { describe, expect, it, vi } from "vitest";
import { createRenderQueue, enqueueRenderJob, type RenderQueueState } from "../core/render-queue";
import { type RenderQueueClient, RenderQueueUiStore } from "./render-queue-store";

const input = {
  id: "job",
  compositionId: "composition",
  compositionName: "Main",
  projectRevision: 1,
  projectSnapshot: '{"schemaVersion":5}',
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30, denominator: 1 },
  startFrame: 0,
  endFrameExclusive: 30,
  outputs: [
    {
      id: "video",
      kind: "mp4" as const,
      destination: "C:\\renders\\main.mp4",
      codec: "h264" as const,
      bitrateMbps: 20,
      includeAudio: false,
    },
  ],
};

function harness(initial: RenderQueueState = createRenderQueue()) {
  let state = initial;
  let changed: ((queue: RenderQueueState) => void) | undefined;
  const callbacks: Array<() => void> = [];
  const client: RenderQueueClient = {
    snapshot: vi.fn(async () => state),
    enqueue: vi.fn(async (value) => {
      state = enqueueRenderJob(state, value, () => "generated");
      return state;
    }),
    command: vi.fn(async () => state),
    onChanged: vi.fn((listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    }),
  };
  const store = new RenderQueueUiStore(client, {
    request(callback) {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel: vi.fn(),
  });
  return {
    client,
    store,
    emit: (queue: RenderQueueState) => changed?.(queue),
    flush: () => callbacks.shift()?.(),
  };
}

describe("RenderQueueUiStore", () => {
  it("restores the persisted snapshot and coalesces progress bursts to one paint", async () => {
    const context = harness();
    const listener = vi.fn();
    context.store.subscribe(listener);
    context.store.start();
    await Promise.resolve();
    context.flush();
    expect(context.store.getSnapshot().loading).toBe(false);

    const first = enqueueRenderJob(createRenderQueue(), input);
    const second = { ...first, revision: first.revision + 1 };
    context.emit(first);
    context.emit(second);
    expect(context.store.getSnapshot().queue.items).toEqual([]);
    context.flush();
    expect(context.store.getSnapshot().queue).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tracks per-job command latency and surfaces process-boundary errors", async () => {
    const initial = enqueueRenderJob(createRenderQueue(), input);
    const context = harness(initial);
    context.store.start();
    await Promise.resolve();
    context.flush();
    let reject!: (error: Error) => void;
    vi.mocked(context.client.command).mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    const command = context.store.command({ type: "pause", jobId: "job" });
    expect(context.store.getSnapshot().pendingJobIds.has("job")).toBe(true);
    reject(new Error("lease rejected"));
    await expect(command).rejects.toThrow("lease rejected");
    expect(context.store.getSnapshot().pendingJobIds.has("job")).toBe(false);
    expect(context.store.getSnapshot().error).toBe("lease rejected");
  });

  it("enqueues through the external store without losing the returned revision", async () => {
    const context = harness();
    context.store.start();
    await Promise.resolve();
    context.flush();
    await context.store.enqueue(input);
    expect(context.store.getSnapshot().queue.items[0]?.manifest.id).toBe("job");
  });
});
