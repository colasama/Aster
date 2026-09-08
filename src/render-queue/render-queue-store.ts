import type { EnqueueRenderJobInput, RenderQueueViewState } from "../core/rendering/render-queue";
import { desktopRenderQueue, isDesktopRuntime } from "../desktop/api";

export type RenderQueueUiCommand =
  | { type: "pause" | "resume" | "cancel" | "retry" | "remove"; jobId: string }
  | { type: "reprioritize"; jobId: string; priority: number };

export interface RenderQueueClient {
  snapshot(): Promise<RenderQueueViewState>;
  enqueue(input: EnqueueRenderJobInput): Promise<RenderQueueViewState>;
  command(command: RenderQueueUiCommand): Promise<RenderQueueViewState>;
  onChanged(listener: (queue: RenderQueueViewState) => void): () => void;
}

export interface RenderQueueUiSnapshot {
  readonly queue: RenderQueueViewState;
  readonly loading: boolean;
  readonly pendingJobIds: ReadonlySet<string>;
  readonly error?: string;
}

interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const EMPTY_PENDING = new Set<string>();
const INITIAL_SNAPSHOT: RenderQueueUiSnapshot = {
  queue: { schemaVersion: 1, revision: 0, items: [] },
  loading: true,
  pendingJobIds: EMPTY_PENDING,
};

/** Renderer-owned projection of the process queue. Progress events are published at most once/rAF. */
export class RenderQueueUiStore {
  readonly #client?: RenderQueueClient;
  readonly #scheduler: FrameScheduler;
  readonly #listeners = new Set<() => void>();
  #snapshot = INITIAL_SNAPSHOT;
  #pendingQueue?: RenderQueueViewState;
  #frame?: number;
  #unsubscribe?: () => void;
  #started = false;
  readonly #pendingCommands = new Map<string, number>();

  constructor(client?: RenderQueueClient, scheduler: FrameScheduler = browserFrameScheduler()) {
    this.#client = client;
    this.#scheduler = scheduler;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): RenderQueueUiSnapshot => this.#snapshot;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (!this.#client) {
      this.#replace({ ...this.#snapshot, loading: false });
      return;
    }
    this.#unsubscribe = this.#client.onChanged((queue) => this.#schedule(queue));
    void this.#client
      .snapshot()
      .then((queue) => this.#schedule(queue))
      .catch((error: unknown) => this.#fail(error));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#frame !== undefined) this.#scheduler.cancel(this.#frame);
    this.#frame = undefined;
    this.#pendingQueue = undefined;
    this.#started = false;
  }

  enqueue(input: EnqueueRenderJobInput): Promise<void> {
    if (!this.#client)
      return Promise.reject(new Error("Background rendering requires Aster Desktop"));
    return this.#run(undefined, () => this.#client?.enqueue(input));
  }

  command(command: RenderQueueUiCommand): Promise<void> {
    if (!this.#client)
      return Promise.reject(new Error("Background rendering requires Aster Desktop"));
    return this.#run(command.jobId, () => this.#client?.command(command));
  }

  clearError(): void {
    if (this.#snapshot.error === undefined) return;
    this.#replace({ ...this.#snapshot, error: undefined });
  }

  reportError(error: unknown): void {
    this.#fail(error);
  }

  async #run(
    jobId: string | undefined,
    request: () => Promise<RenderQueueViewState> | undefined,
  ): Promise<void> {
    if (jobId) this.#beginPending(jobId);
    else this.#replace({ ...this.#snapshot, error: undefined });
    try {
      const queue = await request();
      if (queue) this.#accept(queue);
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      if (jobId) this.#endPending(jobId);
    }
  }

  #beginPending(jobId: string): void {
    this.#pendingCommands.set(jobId, (this.#pendingCommands.get(jobId) ?? 0) + 1);
    this.#replace({
      ...this.#snapshot,
      pendingJobIds: new Set(this.#pendingCommands.keys()),
      error: undefined,
    });
  }

  #endPending(jobId: string): void {
    const count = this.#pendingCommands.get(jobId) ?? 0;
    if (count <= 1) this.#pendingCommands.delete(jobId);
    else this.#pendingCommands.set(jobId, count - 1);
    this.#replace({
      ...this.#snapshot,
      pendingJobIds:
        this.#pendingCommands.size === 0 ? EMPTY_PENDING : new Set(this.#pendingCommands.keys()),
    });
  }

  #schedule(queue: RenderQueueViewState): void {
    const pendingRevision = this.#pendingQueue?.revision ?? -1;
    if (queue.revision < this.#snapshot.queue.revision || queue.revision < pendingRevision) return;
    this.#pendingQueue = queue;
    if (this.#frame !== undefined) return;
    this.#frame = this.#scheduler.request(() => {
      this.#frame = undefined;
      const latest = this.#pendingQueue;
      this.#pendingQueue = undefined;
      if (latest) this.#accept(latest);
    });
  }

  #accept(queue: RenderQueueViewState): void {
    if (queue.revision < this.#snapshot.queue.revision) return;
    this.#replace({ ...this.#snapshot, queue, loading: false });
  }

  #fail(error: unknown): void {
    this.#replace({
      ...this.#snapshot,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #replace(snapshot: RenderQueueUiSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

let defaultStore: RenderQueueUiStore | undefined;

export function getRenderQueueUiStore(): RenderQueueUiStore {
  if (!defaultStore)
    defaultStore = new RenderQueueUiStore(isDesktopRuntime() ? desktopRenderQueue() : undefined);
  return defaultStore;
}

function browserFrameScheduler(): FrameScheduler {
  if (typeof window === "undefined")
    return {
      request: (callback) => {
        callback();
        return 0;
      },
      cancel: () => undefined,
    };
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}
