import {
  type CpuTask,
  CpuTaskError,
  type CpuTaskRequest,
  type CpuTaskResponse,
  type CpuTaskResult,
  deserializeCpuTaskError,
} from "./cpu-task-protocol";
import { executeCpuTask } from "./cpu-task-runner";

export const MAX_CPU_WORKERS = 8;
export const MAX_CPU_QUEUE_CAPACITY = 1_024;
export const MAX_CPU_TASK_TIMEOUT_MS = 120_000;

export type CpuTaskPriority = "background" | "interactive" | "normal";
export type CpuSchedulerBackend = "inline" | "worker";

export interface CpuTaskOptions {
  priority?: CpuTaskPriority;
  signal?: AbortSignal;
  timeoutMs?: number;
  transfer?: Transferable[];
}

export interface CpuSchedulerStatistics {
  active: number;
  backend: CpuSchedulerBackend;
  capacity: number;
  concurrency: number;
  queued: number;
}

export interface CpuWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<CpuTaskResponse>) => void) | null;
  postMessage(message: CpuTaskRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface CpuSchedulerOptions {
  concurrency?: number;
  maxQueued?: number;
  workerFactory?: (() => CpuWorkerLike) | null;
}

interface PendingCpuTask {
  abortListener?: () => void;
  id: number;
  priority: number;
  reject: (reason: unknown) => void;
  resolve: (value: never) => void;
  sequence: number;
  signal?: AbortSignal;
  task: CpuTask;
  timeoutMs: number;
  transfer?: Transferable[];
}

interface WorkerSlot {
  job?: PendingCpuTask;
  timeout?: ReturnType<typeof setTimeout>;
  worker: CpuWorkerLike;
}

const PRIORITY_WEIGHT: Record<CpuTaskPriority, number> = {
  background: 0,
  normal: 1,
  interactive: 2,
};

export class CpuTaskScheduler {
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #workerFactory?: () => CpuWorkerLike;
  readonly #queue: PendingCpuTask[] = [];
  readonly #slots = new Set<WorkerSlot>();
  #activeInline = 0;
  #backend: CpuSchedulerBackend;
  #disposed = false;
  #drainScheduled = false;
  #nextId = 1;
  #nextSequence = 1;

  constructor(options: CpuSchedulerOptions = {}) {
    this.#concurrency = requireBoundedInteger(
      "concurrency",
      options.concurrency ?? recommendedWorkerCount(),
      1,
      MAX_CPU_WORKERS,
    );
    this.#maxQueued = requireBoundedInteger(
      "maxQueued",
      options.maxQueued ?? 64,
      1,
      MAX_CPU_QUEUE_CAPACITY,
    );
    this.#workerFactory =
      options.workerFactory === null
        ? undefined
        : (options.workerFactory ?? createBrowserWorkerFactory());
    this.#backend = this.#workerFactory ? "worker" : "inline";
  }

  submit<T extends CpuTask>(task: T, options: CpuTaskOptions = {}): Promise<CpuTaskResult<T>> {
    if (this.#disposed)
      return Promise.reject(schedulerError("disposed", "CPU scheduler is disposed"));
    if (options.signal?.aborted) return Promise.reject(cancelledError());
    if (this.#queue.length >= this.#maxQueued) {
      return Promise.reject(
        schedulerError("queue-full", `CPU task queue capacity (${this.#maxQueued}) was reached`),
      );
    }
    const priority = PRIORITY_WEIGHT[options.priority ?? "normal"];
    const timeoutMs = requireBoundedInteger(
      "timeoutMs",
      options.timeoutMs ?? 30_000,
      1,
      MAX_CPU_TASK_TIMEOUT_MS,
    );
    return new Promise<CpuTaskResult<T>>((resolve, reject) => {
      const pending: PendingCpuTask = {
        id: this.#nextId++,
        priority,
        reject,
        resolve: resolve as (value: never) => void,
        sequence: this.#nextSequence++,
        signal: options.signal,
        task,
        timeoutMs,
        transfer: options.transfer,
      };
      pending.abortListener = () => this.#cancel(pending);
      pending.signal?.addEventListener("abort", pending.abortListener, { once: true });
      this.#queue.push(pending);
      this.#queue.sort(
        (left, right) => right.priority - left.priority || left.sequence - right.sequence,
      );
      this.#scheduleDrain();
    });
  }

  statistics(): CpuSchedulerStatistics {
    return {
      active: this.#backend === "worker" ? activeSlotCount(this.#slots) : this.#activeInline,
      backend: this.#backend,
      capacity: this.#maxQueued,
      concurrency: this.#backend === "worker" ? this.#concurrency : 1,
      queued: this.#queue.length,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#queue.splice(0)) this.#reject(pending, cancelledError("disposed"));
    for (const slot of this.#slots) {
      if (slot.timeout) clearTimeout(slot.timeout);
      slot.worker.terminate();
      if (slot.job) this.#reject(slot.job, cancelledError("disposed"));
    }
    this.#slots.clear();
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#disposed || this.#queue.length === 0) return;
    if (this.#backend === "inline") {
      this.#drainInline();
      return;
    }
    while (this.#queue.length > 0) {
      let slot = [...this.#slots].find((candidate) => !candidate.job);
      if (!slot && this.#slots.size < this.#concurrency) slot = this.#createSlot();
      if (!slot) return;
      const pending = this.#queue.shift();
      if (!pending) return;
      this.#dispatch(slot, pending);
    }
  }

  #drainInline(): void {
    if (this.#activeInline > 0) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    this.#activeInline = 1;
    queueMicrotask(() => {
      if (pending.signal?.aborted) {
        this.#reject(pending, cancelledError());
      } else {
        try {
          this.#resolve(pending, executeCpuTask(pending.task));
        } catch (error) {
          this.#reject(pending, error);
        }
      }
      this.#activeInline = 0;
      this.#scheduleDrain();
    });
  }

  #createSlot(): WorkerSlot | undefined {
    try {
      const worker = this.#workerFactory?.();
      if (!worker) throw new Error("Worker factory returned no worker");
      const slot: WorkerSlot = { worker };
      worker.onmessage = (event) => this.#handleResponse(slot, event.data);
      worker.onerror = (event) => this.#handleWorkerFailure(slot, event.message || "Worker failed");
      this.#slots.add(slot);
      return slot;
    } catch {
      if (this.#slots.size > 0) return undefined;
      this.#backend = "inline";
      this.#scheduleDrain();
      return undefined;
    }
  }

  #dispatch(slot: WorkerSlot, pending: PendingCpuTask): void {
    slot.job = pending;
    slot.timeout = setTimeout(() => {
      this.#replaceSlot(
        slot,
        schedulerError("timeout", `CPU task timed out after ${pending.timeoutMs} ms`),
      );
    }, pending.timeoutMs);
    try {
      slot.worker.postMessage({ id: pending.id, task: pending.task }, pending.transfer);
    } catch (error) {
      this.#replaceSlot(slot, error);
    }
  }

  #handleResponse(slot: WorkerSlot, response: CpuTaskResponse): void {
    const pending = slot.job;
    if (!pending || response.id !== pending.id) {
      this.#replaceSlot(
        slot,
        schedulerError("protocol", "CPU worker returned an unexpected task id"),
      );
      return;
    }
    this.#releaseSlot(slot);
    if (response.ok && matchesTaskResult(pending.task, response.result)) {
      this.#resolve(pending, response.result);
    } else if (response.ok) {
      this.#replaceSlot(
        slot,
        schedulerError("protocol", `CPU worker returned an invalid ${pending.task.kind} result`),
      );
      this.#reject(
        pending,
        schedulerError("protocol", "CPU worker result type did not match task"),
      );
    } else {
      this.#reject(pending, deserializeCpuTaskError(response.error));
    }
    this.#scheduleDrain();
  }

  #handleWorkerFailure(slot: WorkerSlot, message: string): void {
    this.#replaceSlot(slot, schedulerError("worker-failed", message));
  }

  #replaceSlot(slot: WorkerSlot, reason: unknown): void {
    const pending = slot.job;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.worker.terminate();
    this.#slots.delete(slot);
    if (pending) this.#reject(pending, reason);
    this.#scheduleDrain();
  }

  #releaseSlot(slot: WorkerSlot): void {
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.timeout = undefined;
    slot.job = undefined;
  }

  #cancel(pending: PendingCpuTask): void {
    const queuedIndex = this.#queue.indexOf(pending);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#reject(pending, cancelledError());
      return;
    }
    const slot = [...this.#slots].find((candidate) => candidate.job === pending);
    if (slot) this.#replaceSlot(slot, cancelledError());
  }

  #resolve(pending: PendingCpuTask, value: unknown): void {
    this.#removeAbortListener(pending);
    pending.resolve(value as never);
  }

  #reject(pending: PendingCpuTask, reason: unknown): void {
    this.#removeAbortListener(pending);
    pending.reject(reason);
  }

  #removeAbortListener(pending: PendingCpuTask): void {
    if (pending.abortListener) pending.signal?.removeEventListener("abort", pending.abortListener);
  }
}

let sharedCpuScheduler: CpuTaskScheduler | undefined;

export function runCpuTask<T extends CpuTask>(
  task: T,
  options?: CpuTaskOptions,
): Promise<CpuTaskResult<T>> {
  sharedCpuScheduler ??= new CpuTaskScheduler();
  return sharedCpuScheduler.submit(task, options);
}

function createBrowserWorkerFactory(): (() => CpuWorkerLike) | undefined {
  if (typeof Worker === "undefined") return undefined;
  return () =>
    new Worker(new URL("./cpu-task.worker.ts", import.meta.url), {
      name: "aster-cpu-task",
      type: "module",
    });
}

function recommendedWorkerCount(): number {
  const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(MAX_CPU_WORKERS, hardwareConcurrency - 1));
}

function requireBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function activeSlotCount(slots: Set<WorkerSlot>): number {
  let active = 0;
  for (const slot of slots) if (slot.job) active += 1;
  return active;
}

function matchesTaskResult(task: CpuTask, result: string | Float32Array): boolean {
  return task.kind === "serialize-json"
    ? typeof result === "string"
    : result instanceof Float32Array;
}

function schedulerError(code: string, message: string): CpuTaskError {
  return new CpuTaskError(code, message, "CpuSchedulerError");
}

function cancelledError(reason = "cancelled"): CpuTaskError {
  return new CpuTaskError(reason, "CPU task was cancelled", "AbortError");
}
