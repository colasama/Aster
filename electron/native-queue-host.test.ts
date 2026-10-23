import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { RenderQueueItem } from "../src/core/rendering/render-queue.js";
import { NativeQueueHostFactory } from "./native-queue-host.js";
import type { RenderQueueHostHandle } from "./render-queue-manager.js";

function item(root: string): RenderQueueItem {
  return {
    status: "preparing",
    attempts: 1,
    progress: { completedFrames: 0, totalFrames: 1, elapsedMs: 0 },
    workerLeaseId: "lease",
    manifest: {
      id: "job",
      compositionId: "main",
      compositionName: "Main",
      projectRevision: 0,
      projectSnapshot: "{}",
      width: 2,
      height: 2,
      frameRate: { numerator: 30, denominator: 1 },
      startFrame: 0,
      endFrameExclusive: 1,
      priority: 0,
      createdAt: new Date().toISOString(),
      outputs: [
        {
          id: "still",
          kind: "still",
          format: "png",
          frame: 0,
          destination: join(root, "still.png"),
        },
      ],
    },
  };
}
const runtime = {
  renderer: "renderer",
  executable: "electron",
  host: "host",
  bundle: "bundle",
  bridge: "bridge",
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};

test("dispose waits for pending authorization and releases the acquired lease exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-native-host-"));
  let release!: () => void,
    started!: () => void,
    leases = 0,
    disposed = false;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: unknown[] = [];
  const factory = new NativeQueueHostFactory({
    temporaryRoot: join(root, "jobs"),
    runtime,
    onError: (error) => errors.push(error),
    authorizeMedia: async () => {
      started();
      await pending;
      return {
        dispose: () => {
          leases++;
        },
      };
    },
  });
  try {
    const handle = await factory.launch(item(root), "lease", async () => {
      throw new Error("Disposed worker reported");
    });
    await ready;
    handle.control("cancel");
    const cleanup = Promise.resolve(handle.dispose()).then(() => {
      disposed = true;
    });
    await delay(20);
    expect(disposed).toBe(false);
    expect(leases).toBe(0);
    release();
    await cleanup;
    await handle.dispose();
    expect(leases).toBe(1);
    expect(errors).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    release();
    await factory.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal reports may dispose the worker without waiting on themselves", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-native-host-terminal-"));
  let leases = 0,
    handle: RenderQueueHostHandle,
    done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const errors: unknown[] = [];
  const factory = new NativeQueueHostFactory(
    {
      temporaryRoot: join(root, "jobs"),
      runtime,
      onError: (error) => errors.push(error),
      authorizeMedia: async () => ({
        dispose: () => {
          leases++;
        },
      }),
    },
    {
      prepare: async () => {
        throw new Error("preparation rejected");
      },
      start: async () => {
        throw new Error("must not spawn");
      },
    },
  );
  try {
    handle = await factory.launch(item(root), "lease", async (event) => {
      expect(event).toMatchObject({ type: "failed", error: { message: "preparation rejected" } });
      await handle.dispose();
      done();
    });
    await finished;
    expect(leases).toBe(1);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await factory.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
