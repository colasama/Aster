// @vitest-environment node
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NativePreviewHost } from "./native-preview-host";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  brokers: [] as Array<{ close: ReturnType<typeof vi.fn>; drain: Deferred }>,
  nextReadyError: undefined as Error | undefined,
  nextReadyGate: undefined as Deferred | undefined,
  directories: 0,
  pendingGates: new Set<Deferred>(),
  cleanedPaths: [] as string[],
  cleanup: undefined as Deferred | undefined,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, callback: Handler) => mocks.handlers.set(channel, callback),
  },
}));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}${++mocks.directories}`),
  readFile: vi.fn().mockResolvedValue(Buffer.from("{}")),
  rm: vi.fn(async (path: string) => {
    await mocks.cleanup?.promise;
    mocks.cleanedPaths.push(path);
  }),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./native-preview-snapshot.js", () => ({
  parsePreviewSnapshot: (value: unknown) => value,
  preparePreviewSnapshot: vi.fn(async () => ({
    project: "project.json",
    request: "request.json",
    mediaCache: undefined,
  })),
}));
vi.mock("./native-preview-client.js", () => ({
  NativePreviewClient: class {
    current = {
      width: 16,
      height: 16,
      source: {
        kind: "project",
        authored_sha256: createHash("sha256").update("{}").digest("hex"),
        scope: "snapshot",
        revision: 1,
        composition_id: "scene",
      },
    };
    ready: Promise<unknown>;
    constructor() {
      const failure = mocks.nextReadyError;
      const gate = mocks.nextReadyGate;
      mocks.nextReadyError = undefined;
      mocks.nextReadyGate = undefined;
      this.ready = gate
        ? gate.promise.then(() => this.current)
        : failure
          ? Promise.reject(failure)
          : Promise.resolve(this.current);
    }
    abort = vi.fn();
  },
}));
vi.mock("./native-preview-broker.js", () => ({
  NativePreviewBroker: class {
    drain = deferred();
    close = vi.fn(() => this.drain.promise);
    constructor() {
      mocks.brokers.push(this);
    }
  },
}));

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const gate: Deferred = {
    promise,
    resolve: () => {
      mocks.pendingGates.delete(gate);
      resolve();
    },
    reject: (error) => {
      mocks.pendingGates.delete(gate);
      reject(error);
    },
  };
  mocks.pendingGates.add(gate);
  return gate;
}

function owner() {
  return Object.assign(new EventEmitter(), { mainFrame: {} }) as unknown as WebContents;
}

const snapshot = {
  snapshotScope: "snapshot",
  projectRevision: 1,
  compositionId: "scene",
  width: 16,
  height: 16,
  memoryBudgetMb: 64,
};
let host: NativePreviewHost;
let editor: WebContents;

async function invoke(channel: string, contents: WebContents, ...args: unknown[]) {
  const handler = mocks.handlers.get(`aster:native-preview-${channel}`);
  if (!handler) throw new Error("Preview handler missing");
  return handler({ sender: contents, senderFrame: contents.mainFrame }, ...args);
}

async function open(contents = editor): Promise<{ id: string }> {
  return (await invoke("open", contents, snapshot)) as { id: string };
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.brokers.length = 0;
  mocks.nextReadyError = undefined;
  mocks.nextReadyGate = undefined;
  mocks.directories = 0;
  mocks.pendingGates.clear();
  mocks.cleanedPaths.length = 0;
  mocks.cleanup = undefined;
  editor = owner();
  host = new NativePreviewHost({
    enabled: true,
    temporaryRoot: "C:\\aster-preview-capacity-test",
    binary: "renderer.exe",
    compiler: "compiler.dll",
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
    raster: { executable: "electron", host: "host", bundle: "bundle", bridge: "bridge" },
    trusted: () => true,
    save: vi.fn().mockResolvedValue(undefined),
  });
  host.registerIpc();
});

afterEach(async () => {
  // Include readiness gates already consumed by a client constructor, even after an assertion fails.
  for (const gate of [...mocks.pendingGates]) gate.resolve();
  await host.dispose();
  vi.clearAllMocks();
});

describe.skipIf(process.platform !== "win32")("native preview owner capacity", () => {
  test("IPC close revokes access immediately and holds capacity until directory cleanup ends", async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => open()));
    mocks.cleanup = deferred();
    const closing = invoke("close", editor, sessions[0].id);
    await expect(invoke("present", editor, sessions[0].id, 0, 1)).rejects.toThrow("ownership");
    await expect(invoke("replace", editor, sessions[0].id, snapshot)).rejects.toThrow("ownership");
    await expect(open()).rejects.toThrow("viewer limit");
    mocks.brokers[0].drain.resolve();
    await Promise.resolve();
    await expect(open()).rejects.toThrow("viewer limit");
    mocks.cleanup.resolve();
    await closing;
    await expect(open()).resolves.toHaveProperty("id");
  });

  test.each(["navigation", "render-process-gone", "destroyed"])(
    "%s retains draining capacity and repeated retirement does not close twice",
    async (reason) => {
      const sessions = await Promise.all(Array.from({ length: 4 }, () => open()));
      const retire = () => {
        if (reason === "navigation")
          editor.emit("did-start-navigation", {}, "about:blank", false, true);
        else editor.emit(reason);
      };
      retire();
      retire();
      for (const session of sessions)
        await expect(invoke("close", editor, session.id)).rejects.toThrow("ownership");
      await expect(open()).rejects.toThrow("viewer limit");
      for (const broker of mocks.brokers) expect(broker.close).toHaveBeenCalledOnce();
      mocks.brokers[0].drain.resolve();
      await vi.waitFor(async () => expect(await open()).toHaveProperty("id"));
      await expect(open()).rejects.toThrow("viewer limit");
    },
  );

  test("a failed open retains its slot throughout cleanup, then returns the original error", async () => {
    await Promise.all(Array.from({ length: 3 }, () => open()));
    mocks.nextReadyError = new Error("producer startup failed");
    const failed = expect(open()).rejects.toThrow("producer startup failed");
    await vi.waitFor(() => {
      expect(mocks.brokers).toHaveLength(4);
      expect(mocks.brokers[3].close).toHaveBeenCalledOnce();
    });
    await expect(open()).rejects.toThrow("viewer limit");
    mocks.brokers[3].drain.resolve();
    await failed;
    await expect(open()).resolves.toHaveProperty("id");
  });

  test("retirement racing a failed open shares one cleanup and returns one capacity slot", async () => {
    await Promise.all(Array.from({ length: 3 }, () => open()));
    const startup = deferred();
    mocks.nextReadyGate = startup;
    const failed = expect(open()).rejects.toThrow("producer startup failed");
    void failed.catch(() => undefined);
    await vi.waitFor(() => expect(mocks.brokers).toHaveLength(4));
    editor.emit("render-process-gone");
    await expect(open()).rejects.toThrow("viewer limit");
    startup.reject(new Error("producer startup failed"));
    await vi.waitFor(() => expect(mocks.brokers[3].close).toHaveBeenCalledOnce());
    for (const broker of mocks.brokers) expect(broker.close).toHaveBeenCalledOnce();
    mocks.brokers[3].drain.resolve();
    await failed;
    await expect(open()).resolves.toHaveProperty("id");
    await expect(open()).rejects.toThrow("viewer limit");
  });

  test("a rejected close releases its capacity exactly once after cleanup settles", async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => open()));
    const closing = expect(invoke("close", editor, sessions[0].id)).rejects.toThrow("drain failed");
    await expect(open()).rejects.toThrow("viewer limit");
    mocks.brokers[0].drain.reject(new Error("drain failed"));
    await closing;
    await expect(open()).resolves.toHaveProperty("id");
    await expect(open()).rejects.toThrow("viewer limit");
  });

  test("one owner's completed close does not free another owner's capacity", async () => {
    const other = owner();
    const own = await open();
    await Promise.all(Array.from({ length: 4 }, () => open(other)));
    const closing = invoke("close", editor, own.id);
    mocks.brokers[0].drain.resolve();
    await closing;
    await expect(open(other)).rejects.toThrow("viewer limit");
    await expect(open()).resolves.toHaveProperty("id");
  });

  test("dispose waits for an earlier IPC close and rejects admission during the drain", async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => open()));
    const closing = invoke("close", editor, sessions[0].id);
    const disposed = vi.fn();
    const pending = host.dispose().then(disposed);
    await expect(invoke("available", editor)).resolves.toBe(false);
    await expect(open()).rejects.toThrow("unavailable");
    for (const broker of mocks.brokers.slice(1)) broker.drain.resolve();
    await vi.waitFor(() => {
      for (const index of [2, 3, 4]) {
        expect(mocks.cleanedPaths).toContain(`C:\\aster-preview-capacity-test\\session-${index}`);
        expect(mocks.cleanedPaths).toContain(
          `C:\\aster-preview-capacity-test\\session-${index}.aster-lock`,
        );
      }
    });
    // Let all close/retire promise continuations finish before checking the earlier IPC close.
    await nextTurn();
    expect(mocks.cleanedPaths).not.toContain("C:\\aster-preview-capacity-test\\session-1");
    expect(disposed).not.toHaveBeenCalled();
    mocks.brokers[0].drain.resolve();
    await Promise.all([closing, pending]);
    for (const broker of mocks.brokers) expect(broker.close).toHaveBeenCalledOnce();
  });
});
