import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRenderQueue,
  migrateRenderQueue,
  type RenderQueueState,
  recoverInterruptedRenderJobs,
  serializeRenderQueue,
} from "../src/core/rendering/render-queue.js";
import { replaceFileWithBackup } from "./atomic-file.js";

export interface RenderQueueLoadReport {
  recoveredBackup: boolean;
  resetInvalid: boolean;
  incompatibleFuture: boolean;
  interruptedJobs: number;
}

export interface RenderQueueUpdateOptions {
  /** Progress can be checkpointed in batches; commands and terminal transitions stay immediate. */
  durability?: "deferred" | "immediate";
}

const PROGRESS_CHECKPOINT_INTERVAL_MS = 500;

/** Atomic, version-aware storage for the process-owned background render queue. */
export class RenderQueueStore {
  readonly #path: string;
  readonly #backupPath: string;
  readonly #temporaryPath: string;
  #document = createRenderQueue();
  #writeQueue: Promise<void> = Promise.resolve();
  #writeProtected = false;
  #deferredDocument?: RenderQueueState;
  #deferredTimer?: ReturnType<typeof setTimeout>;
  #persistenceError?: unknown;

  constructor(userDataDirectory: string) {
    this.#path = join(userDataDirectory, "render-queue.json");
    this.#backupPath = join(userDataDirectory, "render-queue.json.backup");
    this.#temporaryPath = join(userDataDirectory, "render-queue.json.tmp");
  }

  async initialize(now = new Date()): Promise<RenderQueueLoadReport> {
    const primary = await this.#read(this.#path);
    if (primary.incompatibleFuture) return this.#protectFuture();

    let recoveredBackup = false;
    let resetInvalid = false;
    if (primary.document) this.#document = primary.document;
    else {
      const backup = await this.#read(this.#backupPath);
      if (backup.incompatibleFuture) return this.#protectFuture();
      if (backup.document) {
        this.#document = backup.document;
        recoveredBackup = true;
      } else {
        resetInvalid = await exists(this.#path);
        this.#document = createRenderQueue();
      }
    }

    const beforeRecovery = this.#document.items.filter((item) => item.workerLeaseId).length;
    this.#document = recoverInterruptedRenderJobs(this.#document, now);
    if (recoveredBackup || resetInvalid || beforeRecovery > 0) {
      await this.#persist();
      await this.#persist();
    }
    return {
      recoveredBackup,
      resetInvalid,
      incompatibleFuture: false,
      interruptedJobs: beforeRecovery,
    };
  }

  snapshot(): RenderQueueState {
    return structuredClone(this.#document);
  }

  update(
    update: (state: RenderQueueState) => RenderQueueState,
    options: RenderQueueUpdateOptions = {},
  ): Promise<RenderQueueState> {
    if (this.#writeProtected)
      return Promise.reject(new Error("Render queue is from a newer build"));
    if (this.#persistenceError) return Promise.reject(this.#persistenceError);
    const next = migrateRenderQueue(update(this.snapshot()));
    if (next.revision < this.#document.revision)
      return Promise.reject(new Error("Render queue revision cannot move backwards"));
    this.#document = next;
    const snapshot = this.snapshot();
    if (options.durability === "deferred") {
      this.#deferredDocument = snapshot;
      this.#scheduleDeferredPersist();
      return Promise.resolve(snapshot);
    }
    this.#cancelDeferredPersist();
    this.#deferredDocument = undefined;
    return this.#enqueuePersist(snapshot).then(() => snapshot);
  }

  async flush(): Promise<void> {
    this.#cancelDeferredPersist();
    const pending = this.#deferredDocument;
    this.#deferredDocument = undefined;
    if (pending) await this.#enqueuePersist(pending);
    await this.#writeQueue;
    if (this.#persistenceError) throw this.#persistenceError;
  }

  #scheduleDeferredPersist(): void {
    if (this.#deferredTimer) return;
    this.#deferredTimer = setTimeout(() => {
      this.#deferredTimer = undefined;
      const pending = this.#deferredDocument;
      this.#deferredDocument = undefined;
      if (pending) void this.#enqueuePersist(pending).catch(() => undefined);
    }, PROGRESS_CHECKPOINT_INTERVAL_MS);
  }

  #cancelDeferredPersist(): void {
    if (this.#deferredTimer) clearTimeout(this.#deferredTimer);
    this.#deferredTimer = undefined;
  }

  #enqueuePersist(document: RenderQueueState): Promise<void> {
    const persistence = this.#writeQueue.then(() => this.#persist(document));
    this.#writeQueue = persistence.catch((error: unknown) => {
      this.#persistenceError = error;
    });
    return persistence;
  }

  async #read(path: string): Promise<{ document?: RenderQueueState; incompatibleFuture: boolean }> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      try {
        return { document: migrateRenderQueue(value), incompatibleFuture: false };
      } catch (error) {
        return {
          incompatibleFuture:
            error instanceof Error && error.message.includes("newer than this build"),
        };
      }
    } catch {
      return { incompatibleFuture: false };
    }
  }

  #protectFuture(): RenderQueueLoadReport {
    this.#writeProtected = true;
    return {
      recoveredBackup: false,
      resetInvalid: false,
      incompatibleFuture: true,
      interruptedJobs: 0,
    };
  }

  async #persist(document: RenderQueueState = this.#document): Promise<void> {
    await replaceFileWithBackup(
      this.#path,
      this.#temporaryPath,
      this.#backupPath,
      serializeRenderQueue(document),
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}
