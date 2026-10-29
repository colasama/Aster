import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type IpcMainInvokeEvent, ipcMain, type WebContents, type WebFrameMain } from "electron";
import type {
  NativePreviewDescriptor,
  NativePreviewSnapshot,
} from "../src/core/rendering/native-preview-protocol.js";
import { NativePreviewBroker } from "./native-preview-broker.js";
import { NativePreviewClient } from "./native-preview-client.js";
import type { ResolvePreviewPlugins } from "./native-preview-plugins.js";
import {
  type PreviewSnapshotMediaCache,
  type PreviewSnapshotRuntime,
  parsePreviewSnapshot,
  preparePreviewSnapshot,
} from "./native-preview-snapshot.js";

interface HostOptions {
  enabled: boolean;
  temporaryRoot: string;
  binary: string;
  compiler?: string;
  ffmpeg: string;
  ffprobe: string;
  raster: PreviewSnapshotRuntime;
  resolvePlugins?: ResolvePreviewPlugins;
  trusted(contents: WebContents): boolean;
  save(
    directory: string,
    document: unknown,
    assets: NativePreviewSnapshot["runtimeAssets"],
  ): Promise<void>;
}

interface PreviewHostEntry {
  owner: WebContents;
  session: PreviewHostSession;
  closing?: Promise<void>;
}

/** Owns each editor's private preview session; renderer requests cannot choose paths or executables. */
export class NativePreviewHost {
  readonly #sessions = new Map<string, PreviewHostEntry>();
  readonly #ownerCounts = new WeakMap<WebContents, number>();
  readonly #watched = new WeakSet<WebContents>();
  readonly #retirements = new Set<Promise<void>>();
  #disposed = false;
  constructor(readonly options: HostOptions) {}

  registerIpc(): void {
    ipcMain.handle("aster:native-preview-available", (event) => this.#available(event));
    ipcMain.handle("aster:native-preview-open", async (event, value: unknown) => {
      if (!this.#available(event)) throw new Error("Native preview is unavailable");
      const count = this.#ownerCounts.get(event.sender) ?? 0;
      if (count >= 4) throw new Error("Preview viewer limit reached");
      const snapshot = parsePreviewSnapshot(value);
      const id = randomUUID(),
        session = new PreviewHostSession(this.options);
      const entry = { owner: event.sender, session };
      this.#sessions.set(id, entry);
      this.#ownerCounts.set(event.sender, count + 1);
      if (!this.#watched.has(event.sender)) {
        this.#watched.add(event.sender);
        const retire = () => {
          void this.#retire(event.sender);
        };
        event.sender.once("destroyed", retire);
        event.sender.on("render-process-gone", retire);
        event.sender.on("did-start-navigation", (_navigation, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) retire();
        });
      }
      try {
        return { id, ready: await session.replace(snapshot) };
      } catch (error) {
        await this.#close(id, entry);
        throw error;
      }
    });
    ipcMain.handle("aster:native-preview-replace", (event, id: unknown, value: unknown) =>
      this.#owned(event, id).replace(parsePreviewSnapshot(value)),
    );
    ipcMain.handle(
      "aster:native-preview-present",
      (event, id: unknown, time: unknown, request: unknown) => {
        if (
          typeof time !== "number" ||
          !Number.isFinite(time) ||
          !Number.isSafeInteger(request) ||
          (request as number) < 1
        )
          throw new Error("Invalid preview frame address");
        return this.#owned(event, id).present(
          event.sender.mainFrame,
          id as string,
          time,
          request as number,
        );
      },
    );
    ipcMain.handle("aster:native-preview-close", async (event, id: unknown) => {
      this.#owned(event, id);
      const entry = this.#sessions.get(id as string);
      if (entry) await this.#close(id as string, entry);
    });
  }

  #available(event: IpcMainInvokeEvent): boolean {
    return (
      !this.#disposed &&
      this.options.enabled &&
      (process.platform === "win32" || process.platform === "darwin") &&
      this.options.trusted(event.sender) &&
      event.senderFrame === event.sender.mainFrame &&
      [
        this.options.binary,
        ...(this.options.compiler ? [this.options.compiler] : []),
        this.options.ffmpeg,
        this.options.ffprobe,
        this.options.raster.bundle,
        this.options.raster.host,
        this.options.raster.bridge,
      ].every(existsSync)
    );
  }

  #owned(event: IpcMainInvokeEvent, id: unknown): PreviewHostSession {
    const entry = typeof id === "string" ? this.#sessions.get(id) : undefined;
    if (
      !entry ||
      entry.owner !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !this.options.trusted(event.sender)
    )
      throw new Error("Preview session is outside this editor's ownership");
    return entry.session;
  }

  #close(id: string, entry: PreviewHostEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    // Revoke IPC access immediately, but retain capacity until asynchronous cleanup settles.
    this.#sessions.delete(id);
    const pending = entry.session.close().finally(() => {
      const remaining = (this.#ownerCounts.get(entry.owner) ?? 1) - 1;
      if (remaining === 0) this.#ownerCounts.delete(entry.owner);
      else this.#ownerCounts.set(entry.owner, remaining);
      this.#retirements.delete(pending);
    });
    entry.closing = pending;
    this.#retirements.add(pending);
    return pending;
  }

  async #retire(owner?: WebContents): Promise<void> {
    const jobs = [...this.#sessions].filter(([, entry]) => !owner || entry.owner === owner);
    await Promise.allSettled(jobs.map(([id, entry]) => this.#close(id, entry)));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#retire();
    await Promise.allSettled([...this.#retirements]);
  }
}

class PreviewHostSession {
  #mediaCache?: PreviewSnapshotMediaCache;
  #client?: NativePreviewClient;
  #broker?: NativePreviewBroker;
  #directory?: string;
  #address?: { project: string; request: string };
  #index = 0;
  #request = 0;
  #budget?: number;
  #pending?: Promise<unknown>;
  #closing?: Promise<void>;
  #closed = false;
  constructor(readonly options: HostOptions) {}

  replace(snapshot: NativePreviewSnapshot): Promise<NativePreviewDescriptor> {
    return this.#exclusive(async () => {
      if (!this.#directory) {
        await mkdir(this.options.temporaryRoot, { recursive: true });
        this.#directory = await mkdtemp(join(this.options.temporaryRoot, "session-"));
      }
      if (this.#broker && this.#budget !== snapshot.memoryBudgetMb) {
        await this.#broker.close();
        this.#broker = undefined;
        this.#client = undefined;
      }
      this.#budget = snapshot.memoryBudgetMb;
      if (++this.#index > 65536) throw new Error("Preview snapshot generation exhausted");
      const address = await preparePreviewSnapshot({
        directory: this.#directory,
        index: this.#index,
        snapshot,
        runtime: this.options.raster,
        mediaCache: this.#mediaCache,
        resolvePlugins: this.options.resolvePlugins,
        save: this.options.save,
      });
      this.#mediaCache = address.mediaCache;
      if (this.#closed) throw new Error("Preview closed during snapshot preparation");
      if (this.#broker) await this.#broker.replace(address.project, address.request);
      else {
        this.#client = new NativePreviewClient({
          executable: this.options.binary,
          args: [
            "preview-project",
            "--project",
            address.project,
            "--request",
            address.request,
            "--ffmpeg",
            this.options.ffmpeg,
            "--ffprobe",
            this.options.ffprobe,
            ...(this.options.compiler ? ["--dxcompiler", this.options.compiler] : []),
            "--gpu-budget-bytes",
            String(snapshot.memoryBudgetMb * 1048576),
          ],
        });
        this.#broker = new NativePreviewBroker(this.#client);
        await this.#client.ready;
      }
      const ready = this.#client?.current;
      const hash = createHash("sha256")
        .update(await readFile(address.project))
        .digest("hex");
      if (
        ready?.source.kind !== "project" ||
        ready.source.authored_sha256 !== hash ||
        ready.source.scope !== address.scope ||
        ready.source.revision !== snapshot.projectRevision ||
        ready.source.composition_id !== snapshot.compositionId ||
        ready.width !== snapshot.width ||
        ready.height !== snapshot.height
      )
        throw new Error("Native preview admitted a different snapshot");
      const previous = this.#address;
      this.#address = address;
      if (previous) await Promise.all([unlink(previous.project), unlink(previous.request)]);
      return { ...ready, source: ready.source };
    });
  }

  present(frame: WebFrameMain, id: string, time: number, request: number) {
    return this.#exclusive(async () => {
      if (!this.#broker || request <= this.#request)
        throw new Error("Preview request is stale or not ready");
      this.#request = request;
      return this.#broker.present(frame, { id, request }, time);
    });
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#pending)
      return Promise.reject(new Error("Preview session is closed or busy"));
    const pending = work().finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      let failure: unknown;
      try {
        await this.#pending?.catch(() => undefined);
        await this.#broker?.close();
      } catch (error) {
        failure = error;
      }
      this.#client?.abort("Preview editor session closed");
      if (this.#directory) {
        const directory = resolve(this.#directory),
          parent = resolve(this.options.temporaryRoot);
        if (dirname(directory) !== parent || !directory.startsWith(`${parent}${sep}session-`))
          throw new Error("Preview cleanup escaped its private directory");
        await rm(directory, { recursive: true, force: true });
        await rm(`${directory}.aster-lock`, { force: true });
      }
      if (failure) throw failure;
    })();
    return this.#closing;
  }
}
