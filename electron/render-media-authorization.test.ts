import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeRenderMediaSnapshotForLaunch,
  prepareRenderMediaSnapshotForEnqueue,
} from "./render-media-authorization";
import { renderPathKey } from "./render-queue-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("render media local authorization", () => {
  it("persists a verified bundle root and reauthorizes it after app restart", async () => {
    const { root, path, identity } = await bundleAsset("plate.png", new Uint8Array([1, 2, 3]));
    const allowed = new Map([[renderPathKey(path), path]]);
    const prepared = await prepareRenderMediaSnapshotForEnqueue(
      manifest({ kind: "bundle", url: localUrl(path), relativePath: "assets/plate.png" }, identity),
      { allowedAssets: allowed },
    );
    expect(JSON.parse(prepared).entries[0].locator.root).toBe(root);

    const restartedAssets = new Map<string, string>();
    await authorizeRenderMediaSnapshotForLaunch(prepared, { allowedAssets: restartedAssets });

    expect(restartedAssets.get(renderPathKey(path))).toBe(path);
  });

  it("fails explicitly when a durable asset is missing or its content identity changed", async () => {
    const { path, identity } = await bundleAsset("changed.png", new Uint8Array([4, 5, 6]));
    const prepared = await prepareRenderMediaSnapshotForEnqueue(
      manifest(
        { kind: "bundle", url: localUrl(path), relativePath: "assets/changed.png" },
        identity,
      ),
      { allowedAssets: new Map([[renderPathKey(path), path]]) },
    );
    await writeFile(path, new Uint8Array([9, 9, 9]));
    await expect(
      authorizeRenderMediaSnapshotForLaunch(prepared, { allowedAssets: new Map() }),
    ).rejects.toThrow("identity mismatch");

    await rm(path);
    await expect(
      authorizeRenderMediaSnapshotForLaunch(prepared, { allowedAssets: new Map() }),
    ).rejects.toThrow("missing");
  });

  it("keeps external local locators session-only and rejects them after restart", async () => {
    const { path, identity } = await bundleAsset("external.wav", new Uint8Array([7, 8]));
    const prepared = await prepareRenderMediaSnapshotForEnqueue(
      manifest({ kind: "session", url: localUrl(path) }, identity),
      { allowedAssets: new Map([[renderPathKey(path), path]]) },
    );
    await expect(
      authorizeRenderMediaSnapshotForLaunch(prepared, { allowedAssets: new Map() }),
    ).rejects.toThrow("authorization expired");
  });

  it("rejects bundle traversal and ungranted renderer paths", async () => {
    const { path, identity } = await bundleAsset("safe.png", new Uint8Array([1]));
    await expect(
      prepareRenderMediaSnapshotForEnqueue(
        manifest({ kind: "bundle", url: localUrl(path), relativePath: "../safe.png" }, identity),
        { allowedAssets: new Map([[renderPathKey(path), path]]) },
      ),
    ).rejects.toThrow("escapes");
    await expect(
      prepareRenderMediaSnapshotForEnqueue(
        manifest({ kind: "session", url: localUrl(path) }, identity),
        { allowedAssets: new Map() },
      ),
    ).rejects.toThrow("not authorized");
  });

  it("does not publish a partial asset grant when a later locator fails", async () => {
    const { path, identity } = await bundleAsset("first.png", new Uint8Array([3, 1, 4]));
    const prepared = JSON.parse(
      await prepareRenderMediaSnapshotForEnqueue(
        manifest(
          { kind: "bundle", url: localUrl(path), relativePath: "assets/first.png" },
          identity,
        ),
        { allowedAssets: new Map([[renderPathKey(path), path]]) },
      ),
    );
    prepared.entries.push({
      ...prepared.entries[0],
      sourceId: "missing",
      locator: {
        ...prepared.entries[0].locator,
        relativePath: "assets/missing.png",
      },
    });
    const launched = new Map<string, string>();

    await expect(
      authorizeRenderMediaSnapshotForLaunch(JSON.stringify(prepared), {
        allowedAssets: launched,
      }),
    ).rejects.toThrow("missing");
    expect(launched.size).toBe(0);
  });
});

async function bundleAsset(name: string, bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "aster-render-media-"));
  temporaryDirectories.push(root);
  const assets = join(root, "assets");
  const path = join(assets, name);
  await mkdir(assets);
  await writeFile(path, bytes);
  return {
    root,
    path,
    identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function localUrl(path: string): string {
  return `aster-asset://local/${encodeURIComponent(path)}`;
}

function manifest(locator: Record<string, unknown>, contentIdentity: string): string {
  return JSON.stringify({
    version: 1,
    entries: [
      {
        kind: "locator",
        sourceId: "source",
        sourceKind: "still",
        contentIdentity,
        locator,
      },
    ],
    payloads: [],
  });
}
