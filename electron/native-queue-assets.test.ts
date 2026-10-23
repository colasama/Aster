import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { MediaBytesIdentity, mediaBytesIdentity } from "../src/importers/media-import-identity";
import { NativeQueueAssetStore } from "./native-queue-assets";

test("native queue assets require a live lease and preserve immutable verified bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-native-queue-assets-"));
  try {
    const source = join(directory, "source.wav"),
      destination = join(directory, "job");
    await mkdir(destination);
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    await writeFile(source, bytes);
    const locator = {
      kind: "session" as const,
      url: `aster-asset://local/${encodeURIComponent(source)}`,
    };
    await expect(
      new NativeQueueAssetStore(destination, []).locator(locator, ".wav"),
    ).rejects.toThrow("media lease");
    const store = new NativeQueueAssetStore(destination, [source]);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const stored = await store.locator(locator, ".wav", hash);
    expect(stored.byteIdentity).toBe(mediaBytesIdentity(bytes));
    expect(await readFile(join(destination, stored.relativePath))).toEqual(bytes);
    await writeFile(source, Buffer.from([9, 9, 9]));
    await expect(store.locator(locator, ".wav", hash)).rejects.toThrow("content identity");
    expect(await readFile(join(destination, stored.relativePath))).toEqual(bytes);
    await expect(
      store.locator({ kind: "session", url: `file:///${source}` }, ".wav"),
    ).rejects.toThrow("local protocol");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("native queue inline captures deduplicate and enforce aggregate bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-native-queue-assets-"));
  try {
    const store = new NativeQueueAssetStore(directory, [], 8, 2);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const captured = store.inline(bytes, ".png", mediaBytesIdentity(bytes));
    bytes[0] = 255;
    const first = await captured;
    expect(await readFile(join(directory, first.relativePath))).toEqual(Buffer.from([1, 2, 3, 4]));
    const copies = await Promise.all([
      store.inline(Uint8Array.from([1, 2, 3, 4]), ".png"),
      store.locator({ kind: "inline", dataUrl: "data:image/png;base64,AQIDBA==" }, ".png"),
    ]);
    expect(copies).toEqual([first, first]);
    await store.inline(Uint8Array.from([5, 6, 7, 8]), ".png");
    await expect(store.inline(Uint8Array.from([9]), ".png")).rejects.toThrow("budget");
    await expect(store.inline(bytes, "../../escape")).rejects.toThrow("extension");
    await expect(
      store.locator({ kind: "inline", dataUrl: "data:x;base64,A===" }, ".png"),
    ).rejects.toThrow("inline");
    expect(await readdir(join(directory, "assets/native-queue"))).toHaveLength(2);
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("native queue stores never accept tampered copies or overwrite an existing asset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-native-queue-assets-"));
  try {
    const bytes = Uint8Array.from([1, 2, 3]);
    const store = new NativeQueueAssetStore(directory, []);
    const stored = await store.inline(bytes, ".png");
    await writeFile(join(directory, stored.relativePath), "owner changed file");
    await expect(store.inline(bytes, ".png")).rejects.toThrow("changed before reuse");
    await expect(new NativeQueueAssetStore(directory, []).inline(bytes, ".png")).rejects.toThrow(
      "changed while copying",
    );
    expect(await readFile(join(directory, stored.relativePath), "utf8")).toBe("owner changed file");
    const hasher = new MediaBytesIdentity();
    expect(hasher.digest()).toBe("fnv64:811c9dc59e3779b9:0");
    hasher.update(bytes.subarray(0, 1)).update(bytes.subarray(1));
    expect(hasher.digest()).toBe(mediaBytesIdentity(bytes));
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
