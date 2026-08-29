import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AppPreferences,
  applyUserPreferencePatch,
  defaultAppPreferences,
  forgetRecentProject,
  migrateAppPreferences,
  type PersistedWindowState,
  rememberRecentProject,
  type UserPreferencePatch,
} from "../src/desktop/preferences.js";

export class AppPreferencesStore {
  readonly #path: string;
  readonly #backupPath: string;
  readonly #temporaryPath: string;
  #document = defaultAppPreferences();
  #writeQueue: Promise<void> = Promise.resolve();
  #writeProtected = false;
  #acceptLegacyRendererPreferences = false;

  constructor(userDataDirectory: string) {
    this.#path = join(userDataDirectory, "preferences.json");
    this.#backupPath = join(userDataDirectory, "preferences.json.backup");
    this.#temporaryPath = join(userDataDirectory, "preferences.json.tmp");
  }

  async initialize(): Promise<{
    recoveredBackup: boolean;
    resetInvalid: boolean;
    incompatibleFuture: boolean;
  }> {
    const primary = await this.#read(this.#path);
    if (primary.incompatibleFuture) {
      this.#writeProtected = true;
      return { recoveredBackup: false, resetInvalid: false, incompatibleFuture: true };
    }
    if (primary.document) {
      this.#document = primary.document;
      await this.#persist();
      return { recoveredBackup: false, resetInvalid: false, incompatibleFuture: false };
    }
    const backup = await this.#read(this.#backupPath);
    if (backup.incompatibleFuture) {
      this.#writeProtected = true;
      return { recoveredBackup: false, resetInvalid: false, incompatibleFuture: true };
    }
    if (backup.document) {
      this.#document = backup.document;
      await this.#persist();
      await this.#persist();
      return { recoveredBackup: true, resetInvalid: false, incompatibleFuture: false };
    }
    const existed = await readFile(this.#path).then(
      () => true,
      () => false,
    );
    this.#document = defaultAppPreferences();
    this.#acceptLegacyRendererPreferences = !existed;
    if (existed) {
      await this.#persist();
      await this.#persist();
    }
    return { recoveredBackup: false, resetInvalid: existed, incompatibleFuture: false };
  }

  snapshot(): AppPreferences {
    return structuredClone(this.#document);
  }

  updateUserPreferences(patch: UserPreferencePatch): Promise<AppPreferences> {
    this.#acceptLegacyRendererPreferences = false;
    this.#document = applyUserPreferencePatch(this.#document, patch);
    return this.#queuePersist();
  }

  migrateLegacyRendererPreferences(patch: UserPreferencePatch): Promise<AppPreferences> {
    if (!this.#acceptLegacyRendererPreferences) return Promise.resolve(this.snapshot());
    this.#acceptLegacyRendererPreferences = false;
    this.#document = applyUserPreferencePatch(this.#document, patch);
    return this.#queuePersist();
  }

  saveWindowState(windowState: PersistedWindowState): Promise<AppPreferences> {
    this.#document = migrateAppPreferences({ ...this.#document, windowState });
    return this.#queuePersist();
  }

  recordRecentProject(path: string): Promise<AppPreferences> {
    this.#document = rememberRecentProject(this.#document, path);
    return this.#queuePersist();
  }

  removeRecentProject(path: string): Promise<AppPreferences> {
    this.#document = forgetRecentProject(this.#document, path);
    return this.#queuePersist();
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  async #read(path: string): Promise<{ document?: AppPreferences; incompatibleFuture: boolean }> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      try {
        return { document: migrateAppPreferences(value), incompatibleFuture: false };
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

  #queuePersist(): Promise<AppPreferences> {
    const snapshot = this.snapshot();
    if (this.#writeProtected) return Promise.resolve(snapshot);
    this.#writeQueue = this.#writeQueue.then(() => this.#persist(snapshot));
    return this.#writeQueue.then(() => snapshot);
  }

  async #persist(document: AppPreferences = this.#document): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const file = await open(this.#temporaryPath, "w");
    try {
      await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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
