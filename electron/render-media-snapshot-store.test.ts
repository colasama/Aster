import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mediaBytesIdentity } from "../src/importers/media-import-identity";
import { RenderMediaSnapshotStore } from "./render-media-snapshot-store";
import { renderPathKey } from "./render-queue-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RenderMediaSnapshotStore", () => {
  it("renders from the queued content-addressed copy after the original file changes", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source", "take.mp4");
    const original = new Uint8Array([1, 2, 3, 4]);
    await mkdir(dirname(sourcePath));
    await writeFile(sourcePath, original);
    const store = new RenderMediaSnapshotStore(join(root, "snapshots"));
    const allowedAssets = new Map([[renderPathKey(sourcePath), sourcePath]]);

    const captured = await store.capture("job-one", manifest(sourcePath, identity(original)), {
      allowedAssets,
    });
    store.commit("job-one");
    const locator = JSON.parse(captured).entries[0].locator;
    const snapshotPath = localPath(locator.url);
    expect(snapshotPath).not.toBe(sourcePath);
    expect(await readFile(snapshotPath)).toEqual(Buffer.from(original));

    await writeFile(sourcePath, new Uint8Array([9, 9, 9, 9]));
    const restartedAssets = new Map<string, string>();
    const restarted = new RenderMediaSnapshotStore(join(root, "snapshots"));
    const authorization = await restarted.authorizeLaunch("job-one", captured, {
      allowedAssets: restartedAssets,
    });
    const parallelAuthorization = await restarted.authorizeLaunch("job-one", captured, {
      allowedAssets: restartedAssets,
    });

    expect(restartedAssets.get(renderPathKey(snapshotPath))).toBe(snapshotPath);
    expect(restartedAssets.has(renderPathKey(sourcePath))).toBe(false);
    expect(await readFile(snapshotPath)).toEqual(Buffer.from(original));
    authorization.dispose();
    authorization.dispose();
    expect(restartedAssets.get(renderPathKey(snapshotPath))).toBe(snapshotPath);
    parallelAuthorization.dispose();
    expect(restartedAssets.has(renderPathKey(snapshotPath))).toBe(false);
    await expect(
      restarted.capture("stale-job", manifest(sourcePath, identity(original)), {
        allowedAssets: new Map([[renderPathKey(sourcePath), sourcePath]]),
      }),
    ).rejects.toThrow("identity mismatch");
    await expect(stat(restarted.directoryFor("stale-job"))).rejects.toThrow();
  });

  it("rejects a changed job-owned snapshot and a manifest root borrowed from another job", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source", "plate.png");
    const bytes = new Uint8Array([5, 4, 3, 2]);
    await mkdir(dirname(sourcePath));
    await writeFile(sourcePath, bytes);
    const store = new RenderMediaSnapshotStore(join(root, "snapshots"));
    const captured = await store.capture("job-one", manifest(sourcePath, identity(bytes)), {
      allowedAssets: new Map([[renderPathKey(sourcePath), sourcePath]]),
    });
    store.commit("job-one");

    await expect(
      store.authorizeLaunch("job-two", captured, { allowedAssets: new Map() }),
    ).rejects.toThrow("does not belong");

    const snapshotPath = localPath(JSON.parse(captured).entries[0].locator.url);
    await chmod(snapshotPath, 0o600);
    await writeFile(snapshotPath, new Uint8Array([8, 8, 8, 8]));
    await expect(
      store.authorizeLaunch("job-one", captured, { allowedAssets: new Map() }),
    ).rejects.toThrow("identity mismatch");
  });

  it("retains restart and retry media until the durable queue item is removed", async () => {
    const root = await temporaryRoot();
    const snapshots = join(root, "snapshots");
    const sourcePath = join(root, "source.wav");
    const bytes = new Uint8Array([7, 6]);
    await writeFile(sourcePath, bytes);
    const store = new RenderMediaSnapshotStore(snapshots);
    await store.capture("keep", manifest(sourcePath, identity(bytes)), {
      allowedAssets: new Map([[renderPathKey(sourcePath), sourcePath]]),
    });
    store.commit("keep");

    await store.prune(new Set(["keep"]));
    expect((await stat(store.directoryFor("keep"))).isDirectory()).toBe(true);
    await expect(
      store.capture("keep", manifest(sourcePath, identity(bytes)), {
        allowedAssets: new Map([[renderPathKey(sourcePath), sourcePath]]),
      }),
    ).rejects.toThrow();
    expect((await stat(store.directoryFor("keep"))).isDirectory()).toBe(true);
    await store.prune(new Set());
    await expect(stat(store.directoryFor("keep"))).rejects.toThrow();
  });

  it("streams local sequence frames, upgrades FNV identity, and ignores copied mtime", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "frames", "frame_0001.png");
    const original = new Uint8Array([11, 22, 33, 44]);
    await mkdir(dirname(sourcePath));
    await writeFile(sourcePath, original);
    await utimes(sourcePath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const sourceMetadata = await stat(sourcePath);
    const store = new RenderMediaSnapshotStore(join(root, "snapshots"));
    const captured = await store.capture(
      "sequence-job",
      sequenceManifest(sourcePath, original, sourceMetadata.mtimeMs),
      { allowedAssets: new Map([[renderPathKey(sourcePath), sourcePath]]) },
    );
    store.commit("sequence-job");

    const queued = JSON.parse(captured);
    const frame = queued.entries[0].selection.frames[0].file;
    expect(frame.locator.kind).toBe("bundle");
    expect(frame.locator).not.toHaveProperty("dataUrl");
    expect(frame.byteIdentity).toBe(identity(original));
    const snapshotPath = localPath(frame.locator.url);
    expect(Math.abs((await stat(snapshotPath)).mtimeMs - sourceMetadata.mtimeMs)).toBeGreaterThan(
      1,
    );

    await writeFile(sourcePath, new Uint8Array([99, 99, 99, 99]));
    const launchAssets = new Map<string, string>();
    const authorization = await store.authorizeLaunch("sequence-job", captured, {
      allowedAssets: launchAssets,
    });
    expect(await readFile(snapshotPath)).toEqual(Buffer.from(original));
    authorization.dispose();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aster-render-snapshot-"));
  temporaryDirectories.push(root);
  return root;
}

function identity(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function localUrl(path: string): string {
  return `aster-asset://local/${encodeURIComponent(path)}`;
}

function localPath(urlValue: string): string {
  const url = new URL(urlValue);
  return decodeURIComponent(url.pathname.slice(1));
}

function manifest(path: string, contentIdentity: string): string {
  return JSON.stringify({
    version: 1,
    entries: [
      {
        kind: "locator",
        sourceId: "source",
        sourceKind: "video",
        contentIdentity,
        locator: { kind: "session", url: localUrl(path) },
      },
    ],
    payloads: [],
  });
}

function sequenceManifest(path: string, bytes: Uint8Array, lastModified: number): string {
  return JSON.stringify({
    version: 1,
    entries: [
      {
        kind: "imageSequence",
        sourceId: "sequence",
        sourceKind: "imageSequence",
        contentIdentity: "sequence:content",
        selection: {
          pattern: "frame_[####].png",
          prefix: "frame_",
          extension: ".png",
          padding: 4,
          startFrame: 1,
          endFrame: 1,
          missingFrames: [],
          frames: [
            {
              frame: 1,
              file: {
                name: "frame_0001.png",
                size: bytes.byteLength,
                lastModified,
                type: "image/png",
                byteIdentity: mediaBytesIdentity(bytes),
                locator: { kind: "session", url: localUrl(path) },
              },
            },
          ],
        },
        frameRate: { numerator: 24, denominator: 1 },
        missingFramePolicy: "error",
        loop: false,
      },
    ],
    payloads: [],
  });
}
