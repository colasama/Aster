import { randomUUID } from "node:crypto";
import {
  acknowledgeRenderPaused,
  cancelRenderJob,
  claimRenderJob,
  completeRenderJob,
  type EnqueueRenderJobInput,
  enqueueRenderJob,
  failRenderJob,
  markRenderJobRunning,
  nextRunnableRenderJobs,
  type RenderJobProgress,
  type RenderQueueItem,
  type RenderQueueState,
  removeRenderJob,
  reprioritizeRenderJob,
  requestRenderPause,
  resumeRenderJob,
  retryRenderJob,
  updateRenderProgress,
} from "../src/core/render-queue.js";
import type { RenderQueueStore } from "./render-queue-store.js";

export type RenderQueueCommand =
  | { type: "pause"; jobId: string }
  | { type: "resume"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "retry"; jobId: string }
  | { type: "remove"; jobId: string }
  | { type: "reprioritize"; jobId: string; priority: number };

export type RenderHostReport =
  | { type: "prepared"; jobId: string; leaseId: string }
  | { type: "progress"; jobId: string; leaseId: string; progress: RenderJobProgress }
  | { type: "paused"; jobId: string; leaseId: string }
  | { type: "cancelled"; jobId: string; leaseId: string }
  | { type: "completed"; jobId: string; leaseId: string }
  | {
      type: "failed";
      jobId: string;
      leaseId: string;
      error: { code: string; message: string; correlationId?: string };
    };

export interface RenderQueueHostHandle {
  readonly jobId: string;
  readonly leaseId: string;
  control(command: "pause" | "cancel"): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface RenderQueueHostFactory {
  launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle>;
}

interface ActiveHost {
  handle: RenderQueueHostHandle;
  leaseId: string;
  /** Durable state may already be retried or removed while this cancelled lease drains. */
  cancellationRequested: boolean;
}

export class RenderQueueManager {
  readonly #store: RenderQueueStore;
  readonly #publish: (state: RenderQueueState) => void;
  readonly #createLeaseId: () => string;
  readonly #active = new Map<string, ActiveHost>();
  #hostFactory?: RenderQueueHostFactory;
  #maximumConcurrency = 1;
  #scheduling?: Promise<void>;
  #scheduleAgain = false;
  #shuttingDown = false;

  constructor(
    store: RenderQueueStore,
    publish: (state: RenderQueueState) => void,
    createLeaseId: () => string = randomUUID,
  ) {
    this.#store = store;
    this.#publish = publish;
    this.#createLeaseId = createLeaseId;
  }

  snapshot(): RenderQueueState {
    return this.#store.snapshot();
  }

  get activeHostCount(): number {
    return this.#active.size;
  }

  async startScheduler(factory: RenderQueueHostFactory, maximumConcurrency = 1): Promise<void> {
    if (this.#hostFactory) throw new Error("Render queue scheduler is already running");
    if (
      !Number.isSafeInteger(maximumConcurrency) ||
      maximumConcurrency < 1 ||
      maximumConcurrency > 8
    )
      throw new Error("Render queue concurrency must be an integer within 1..=8");
    this.#hostFactory = factory;
    this.#maximumConcurrency = maximumConcurrency;
    await this.#schedule();
  }

  async enqueue(value: unknown): Promise<RenderQueueState> {
    if (!isRecord(value)) throw new Error("Render job must be an object");
    await this.#update((state) =>
      enqueueRenderJob(state, value as unknown as EnqueueRenderJobInput),
    );
    await this.#schedule();
    return this.snapshot();
  }

  async command(value: unknown): Promise<RenderQueueState> {
    const command = parseCommand(value);
    const cancellingHost = command.type === "cancel" ? this.#active.get(command.jobId) : undefined;
    if (cancellingHost) {
      // Mark the lease before the durable write or control IPC can yield. Reports already in flight
      // from this retired generation must never be applied to an immediate retry/remove generation.
      cancellingHost.cancellationRequested = true;
      try {
        await cancellingHost.handle.control("cancel");
      } catch (error) {
        await this.report({
          type: "failed",
          jobId: command.jobId,
          leaseId: cancellingHost.leaseId,
          error: {
            code: "render_host_control_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    await this.#update((state) => {
      switch (command.type) {
        case "pause":
          return requestRenderPause(state, command.jobId);
        case "resume":
          return resumeRenderJob(state, command.jobId);
        case "cancel":
          return cancelRenderJob(state, command.jobId);
        case "retry":
          return retryRenderJob(state, command.jobId);
        case "remove":
          return removeRenderJob(state, command.jobId);
        case "reprioritize":
          return reprioritizeRenderJob(state, command.jobId, command.priority);
      }
    });
    const active = this.#active.get(command.jobId);
    if (active && command.type === "pause") {
      try {
        await active.handle.control("pause");
      } catch (error) {
        await this.report({
          type: "failed",
          jobId: command.jobId,
          leaseId: active.leaseId,
          error: {
            code: "render_host_control_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    await this.#schedule();
    return this.snapshot();
  }

  async report(value: unknown): Promise<void> {
    const event = parseRenderHostReport(value);
    const active = this.#active.get(event.jobId);
    if (!active || active.leaseId !== event.leaseId)
      throw new Error(`Stale render host lease for ${event.jobId}`);

    if (active.cancellationRequested) {
      // Cancellation is terminal for this lease even when the durable item was immediately retried
      // or removed. Ignore in-flight progress from the old generation and release its resources on
      // any terminal boundary without touching the replacement attempt.
      if (event.type !== "prepared" && event.type !== "progress")
        await this.#finishHost(event.jobId, active);
      return;
    }
    if (event.type === "cancelled")
      throw new Error(`Render host cancelled ${event.jobId} without a cancel request`);
    const item = this.snapshot().items.find((candidate) => candidate.manifest.id === event.jobId);
    if (!item) throw new Error(`Unknown render job ${event.jobId}`);

    switch (event.type) {
      case "prepared":
        await this.#update((state) => markRenderJobRunning(state, event.jobId, event.leaseId));
        break;
      case "progress":
        await this.#update(
          (state) => updateRenderProgress(state, event.jobId, event.leaseId, event.progress),
          "deferred",
        );
        break;
      case "paused":
        await this.#update((state) => acknowledgeRenderPaused(state, event.jobId, event.leaseId));
        await this.#finishHost(event.jobId, active);
        break;
      case "completed":
        await this.#update((state) => completeRenderJob(state, event.jobId, event.leaseId));
        await this.#finishHost(event.jobId, active);
        break;
      case "failed":
        await this.#update((state) =>
          failRenderJob(state, event.jobId, event.leaseId, event.error),
        );
        await this.#finishHost(event.jobId, active);
        break;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#hostFactory = undefined;
    await this.#scheduling;
    const activeHosts = [...this.#active.entries()];
    this.#active.clear();
    for (const [jobId, active] of activeHosts) {
      await Promise.resolve(active.handle.control("cancel")).catch(() => undefined);
      await Promise.resolve(active.handle.dispose()).catch(() => undefined);
      const item = this.snapshot().items.find((candidate) => candidate.manifest.id === jobId);
      if (item?.workerLeaseId === active.leaseId)
        await this.#update((state) =>
          failRenderJob(state, jobId, active.leaseId, {
            code: "render_host_shutdown",
            message: "Aster exited before the background render completed.",
          }),
        );
    }
    await this.#store.flush();
  }

  flush(): Promise<void> {
    return this.#store.flush();
  }

  async #schedule(): Promise<void> {
    if (!this.#hostFactory || this.#shuttingDown) return;
    if (this.#scheduling) {
      this.#scheduleAgain = true;
      return this.#scheduling;
    }
    this.#scheduling = (async () => {
      do {
        this.#scheduleAgain = false;
        await this.#schedulePass();
      } while (this.#scheduleAgain && this.#hostFactory && !this.#shuttingDown);
    })();
    try {
      await this.#scheduling;
    } finally {
      this.#scheduling = undefined;
    }
  }

  async #schedulePass(): Promise<void> {
    const factory = this.#hostFactory;
    if (!factory) return;
    // A cancelled item leaves the persistent state immediately but its hidden host still owns GPU,
    // encoder, and staging resources until it acknowledges the control boundary. Bound launches by
    // live host handles as well as domain state so cleanup never creates a transient extra worker.
    const availableHostSlots = Math.max(0, this.#maximumConcurrency - this.#active.size);
    if (availableHostSlots === 0) return;
    const runnable = nextRunnableRenderJobs(this.snapshot(), this.#maximumConcurrency).slice(
      0,
      availableHostSlots,
    );
    for (const item of runnable) {
      const jobId = item.manifest.id;
      const leaseId = this.#createLeaseId();
      await this.#update((state) => claimRenderJob(state, jobId, leaseId));
      try {
        const claimed = this.snapshot().items.find((candidate) => candidate.manifest.id === jobId);
        if (!claimed) throw new Error(`Unknown render job ${jobId}`);
        const handle = await factory.launch(claimed, leaseId, (event) => this.report(event));
        if (handle.jobId !== jobId || handle.leaseId !== leaseId)
          throw new Error("Render host returned a mismatched job lease");
        const current = this.snapshot().items.find((candidate) => candidate.manifest.id === jobId);
        if (!current || current.workerLeaseId !== leaseId) {
          // Cancel/retry can advance the durable item while slow media authorization or publisher
          // preparation is still launching. Never attach that now-stale host to the replacement job.
          await Promise.resolve(handle.control("cancel")).catch(() => undefined);
          await Promise.resolve(handle.dispose()).catch(() => undefined);
          this.#scheduleAgain = true;
          continue;
        }
        this.#active.set(jobId, { handle, leaseId, cancellationRequested: false });
      } catch (error) {
        const current = this.snapshot().items.find((candidate) => candidate.manifest.id === jobId);
        // Cancellation or retry may already have retired this launch lease while authorization was
        // pending. Preserve that newer state instead of trying to publish failure through a stale
        // lease (which would itself violate the queue transition contract).
        if (current?.workerLeaseId === leaseId)
          await this.#update((state) =>
            failRenderJob(state, jobId, leaseId, {
              code: "render_host_launch_failed",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        this.#scheduleAgain = true;
      }
    }
  }

  async #finishHost(jobId: string, active: ActiveHost): Promise<void> {
    if (this.#active.get(jobId) !== active) return;
    this.#active.delete(jobId);
    await Promise.resolve(active.handle.dispose()).catch(() => undefined);
    await this.#schedule();
  }

  async #update(
    update: (state: RenderQueueState) => RenderQueueState,
    durability: "deferred" | "immediate" = "immediate",
  ): Promise<RenderQueueState> {
    const state = await this.#store.update(update, { durability });
    this.#publish(state);
    return state;
  }
}

function parseCommand(value: unknown): RenderQueueCommand {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Render queue command is invalid");
  const jobId = boundedId(value.jobId, "Render queue job ID");
  if (["pause", "resume", "cancel", "retry", "remove"].includes(value.type)) {
    assertKeys(value, ["type", "jobId"], "Render queue command");
    return {
      type: value.type as "pause" | "resume" | "cancel" | "retry" | "remove",
      jobId,
    };
  }
  if (value.type === "reprioritize") {
    assertKeys(value, ["type", "jobId", "priority"], "Render queue command");
    if (!Number.isSafeInteger(value.priority)) throw new Error("Render priority is invalid");
    return { type: "reprioritize", jobId, priority: Number(value.priority) };
  }
  throw new Error("Render queue command type is invalid");
}

export function parseRenderHostReport(value: unknown): RenderHostReport {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Render host report is invalid");
  const jobId = boundedId(value.jobId, "Render host job ID");
  const leaseId = boundedId(value.leaseId, "Render host lease ID");
  if (["prepared", "paused", "cancelled", "completed"].includes(value.type)) {
    assertKeys(value, ["type", "jobId", "leaseId"], "Render host report");
    return {
      type: value.type as "prepared" | "paused" | "cancelled" | "completed",
      jobId,
      leaseId,
    };
  }
  if (value.type === "progress") {
    assertKeys(value, ["type", "jobId", "leaseId", "progress"], "Render host report");
    if (!isRecord(value.progress)) throw new Error("Render host progress is invalid");
    assertKeys(
      value.progress,
      ["completedFrames", "totalFrames", "elapsedMs", "estimatedRemainingMs"],
      "Render host progress",
      true,
    );
    return {
      type: "progress",
      jobId,
      leaseId,
      progress: {
        completedFrames: finiteNumber(value.progress.completedFrames, "completed frames"),
        totalFrames: finiteNumber(value.progress.totalFrames, "total frames"),
        elapsedMs: finiteNumber(value.progress.elapsedMs, "elapsed milliseconds"),
        ...(value.progress.estimatedRemainingMs === undefined
          ? {}
          : {
              estimatedRemainingMs: finiteNumber(
                value.progress.estimatedRemainingMs,
                "estimated remaining milliseconds",
              ),
            }),
      },
    };
  }
  if (value.type === "failed") {
    assertKeys(value, ["type", "jobId", "leaseId", "error"], "Render host report");
    if (!isRecord(value.error)) throw new Error("Render host error is invalid");
    assertKeys(value.error, ["code", "message", "correlationId"], "Render host error", true);
    return {
      type: "failed",
      jobId,
      leaseId,
      error: {
        code: boundedString(value.error.code, 96, "Render host error code"),
        message: boundedString(value.error.message, 2_048, "Render host error message"),
        ...(value.error.correlationId === undefined
          ? {}
          : { correlationId: boundedId(value.error.correlationId, "Render correlation ID") }),
      },
    };
  }
  throw new Error("Render host report type is invalid");
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optionalLast = false,
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw new Error(`${label} has unknown fields`);
  const required = optionalLast ? allowed.slice(0, -1) : allowed;
  if (required.some((key) => !(key in value))) throw new Error(`${label} is missing fields`);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Render host ${label} is invalid`);
  return value;
}

function boundedId(value: unknown, label: string): string {
  return boundedString(value, 128, label);
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
