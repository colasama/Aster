import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createRenderQueue,
  migrateRenderQueue,
  type RenderQueueState,
  recoverInterruptedRenderJobs,
  serializeRenderQueue,
} from "../src/core/render-queue.js";

export interface RenderQueueLoadReport {
  recoveredBackup: boolean;
  resetInvalid: boolean;
  incompatibleFuture: boolean;
  interruptedJobs: number;
}

/** Atomic, version-aware storage for the process-owned background render queue. */
export class RenderQueueStore {
  readonly #path: string;
  readonly #backupPath: string;
  readonly #temporaryPath: string;
  #document = createRenderQueue();
  #writeQueue: Promise<void> = Promise.resolve();
  #writeProtected = false;

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

  update(update: (state: RenderQueueState) => RenderQueueState): Promise<RenderQueueState> {
    if (this.#writeProtected)
      return Promise.reject(new Error("Render queue is from a newer build"));
    const next = migrateRenderQueue(update(this.snapshot()));
    if (next.revision < this.#document.revision)
      return Promise.reject(new Error("Render queue revision cannot move backwards"));
    this.#document = next;
    const snapshot = this.snapshot();
    this.#writeQueue = this.#writeQueue.then(() => this.#persist(snapshot));
    return this.#writeQueue.then(() => structuredClone(snapshot));
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
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
    await mkdir(dirname(this.#path), { recursive: true });
    const file = await open(this.#temporaryPath, "w");
    try {
      await file.writeFile(serializeRenderQueue(document), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rm(this.#backupPath, { force: true });
    const hadPrimary = await rename(this.#path, this.#backupPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    try {
      await rename(this.#temporaryPath, this.#path);
    } catch (error) {
      if (hadPrimary) await rename(this.#backupPath, this.#path).catch(() => undefined);
      throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}
