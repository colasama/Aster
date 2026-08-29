import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  authorizeRenderMediaSnapshotForLaunch,
  prepareRenderMediaSnapshotForEnqueue,
} from "./render-media-authorization.js";
import { renderPathKey } from "./render-queue-paths.js";

interface SnapshotAuthorization {
  allowedAssets: Map<string, string>;
}

export interface RenderMediaAuthorizationLease {
  dispose(): void;
}

interface AuthorizationReference {
  count: number;
  owned: boolean;
  path: string;
  target: Map<string, string>;
}

/**
 * Owns immutable linked-media copies for persisted render jobs. A directory is retained for as long
 * as its queue item exists, so retry and restart never return to a mutable source file.
 */
export class RenderMediaSnapshotStore {
  readonly #root: string;
  readonly #pending = new Set<string>();
  readonly #authorizationReferences = new Map<string, AuthorizationReference>();
  #retained = new Set<string>();
  #maintenance: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async capture(
    jobId: string,
    snapshot: string,
    authorization: SnapshotAuthorization,
  ): Promise<string> {
    const directory = this.directoryFor(jobId);
    if (this.#pending.has(jobId))
      throw new Error("Render media snapshot capture is already pending");
    this.#pending.add(jobId);
    let created = false;
    try {
      // A prune that started before this capture cannot race a newly created job directory.
      await this.#maintenance;
      await mkdir(this.#root, { recursive: true });
      await mkdir(directory, { recursive: false });
      created = true;
      return await prepareRenderMediaSnapshotForEnqueue(snapshot, {
        ...authorization,
        snapshotDirectory: directory,
      });
    } catch (error) {
      this.#pending.delete(jobId);
      if (created) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  commit(jobId: string): void {
    this.#pending.delete(jobId);
  }

  async discard(jobId: string): Promise<void> {
    this.#pending.delete(jobId);
    await rm(this.directoryFor(jobId), { recursive: true, force: true });
  }

  async authorizeLaunch(
    jobId: string,
    snapshot: string,
    authorization: SnapshotAuthorization,
  ): Promise<RenderMediaAuthorizationLease> {
    const authorized = await authorizeRenderMediaSnapshotForLaunch(snapshot, {
      ...authorization,
      expectedSnapshotDirectory: this.directoryFor(jobId),
    });
    const keys: string[] = [];
    for (const grant of authorized) {
      const key = renderPathKey(grant.path);
      const reference = this.#authorizationReferences.get(key);
      if (reference) reference.count += 1;
      else
        this.#authorizationReferences.set(key, {
          count: 1,
          owned: !grant.wasAuthorized,
          path: grant.path,
          target: authorization.allowedAssets,
        });
      keys.push(key);
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const key of keys) {
          const reference = this.#authorizationReferences.get(key);
          if (!reference) continue;
          reference.count -= 1;
          if (reference.count > 0) continue;
          this.#authorizationReferences.delete(key);
          if (reference.owned && reference.target.get(key) === reference.path)
            reference.target.delete(key);
        }
      },
    };
  }

  /** Removes media only after its durable queue item is gone. Calls are serialized with capture. */
  prune(retainedJobIds: ReadonlySet<string>): Promise<void> {
    this.#retained = new Set(retainedJobIds);
    const operation = async () => {
      await mkdir(this.#root, { recursive: true });
      const retainedDirectories = new Set(
        [...this.#retained, ...this.#pending].map((jobId) => this.directoryName(jobId)),
      );
      const entries = await readdir(this.#root, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !retainedDirectories.has(entry.name))
          .map((entry) => rm(join(this.#root, entry.name), { recursive: true, force: true })),
      );
    };
    this.#maintenance = this.#maintenance.then(operation, operation);
    return this.#maintenance;
  }

  directoryFor(jobId: string): string {
    if (!jobId || jobId.length > 256) throw new Error("Render job id is invalid");
    return join(this.#root, this.directoryName(jobId));
  }

  directoryName(jobId: string): string {
    return createHash("sha256").update(jobId).digest("hex");
  }
}
