import {
  cancelRenderJob,
  type EnqueueRenderJobInput,
  enqueueRenderJob,
  type RenderQueueState,
  reprioritizeRenderJob,
  requestRenderPause,
  resumeRenderJob,
  retryRenderJob,
} from "../src/core/render-queue.js";
import type { RenderQueueStore } from "./render-queue-store.js";

export type RenderQueueCommand =
  | { type: "pause"; jobId: string }
  | { type: "resume"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "retry"; jobId: string }
  | { type: "reprioritize"; jobId: string; priority: number };

export class RenderQueueManager {
  readonly #store: RenderQueueStore;
  readonly #publish: (state: RenderQueueState) => void;

  constructor(store: RenderQueueStore, publish: (state: RenderQueueState) => void) {
    this.#store = store;
    this.#publish = publish;
  }

  snapshot(): RenderQueueState {
    return this.#store.snapshot();
  }

  async enqueue(value: unknown): Promise<RenderQueueState> {
    if (!isRecord(value)) throw new Error("Render job must be an object");
    return this.#update((state) =>
      enqueueRenderJob(state, value as unknown as EnqueueRenderJobInput),
    );
  }

  async command(value: unknown): Promise<RenderQueueState> {
    const command = parseCommand(value);
    return this.#update((state) => {
      switch (command.type) {
        case "pause":
          return requestRenderPause(state, command.jobId);
        case "resume":
          return resumeRenderJob(state, command.jobId);
        case "cancel":
          return cancelRenderJob(state, command.jobId);
        case "retry":
          return retryRenderJob(state, command.jobId);
        case "reprioritize":
          return reprioritizeRenderJob(state, command.jobId, command.priority);
      }
    });
  }

  flush(): Promise<void> {
    return this.#store.flush();
  }

  async #update(update: (state: RenderQueueState) => RenderQueueState): Promise<RenderQueueState> {
    const state = await this.#store.update(update);
    this.#publish(state);
    return state;
  }
}

function parseCommand(value: unknown): RenderQueueCommand {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Render queue command is invalid");
  if (typeof value.jobId !== "string" || value.jobId.length < 1 || value.jobId.length > 128)
    throw new Error("Render queue job ID is invalid");
  const jobId = value.jobId;
  if (["pause", "resume", "cancel", "retry"].includes(value.type))
    return { type: value.type as "pause" | "resume" | "cancel" | "retry", jobId };
  if (value.type === "reprioritize") {
    if (!Number.isSafeInteger(value.priority)) throw new Error("Render priority is invalid");
    return { type: "reprioritize", jobId, priority: Number(value.priority) };
  }
  throw new Error("Render queue command type is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
