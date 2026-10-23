import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, toNamespacedPath } from "node:path";
import { MediaBytesIdentity } from "../src/importers/media-import-identity.js";
import type { RenderMediaLocator } from "../src/render-queue/render-media-codec.js";
import { renderPathKey } from "./render-queue-paths.js";

interface AssetIdentity {
  sha256: string;
  byteIdentity: string;
  bytes: number;
}
export interface NativeQueueAsset {
  kind: "relative";
  relativePath: string;
  byteIdentity: string;
}

/** Job-private copies of explicitly leased files; never resolves arbitrary persisted locators. */
export class NativeQueueAssetStore {
  readonly #root: string;
  readonly #allowed: Map<string, string>;
  readonly #pending = new Map<string, Promise<NativeQueueAsset>>();
  #bytes = 0;
  constructor(
    directory: string,
    authorizedPaths: readonly string[],
    readonly maximumBytes = 2_147_483_648,
    readonly maximumFiles = 100_000,
  ) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 2_147_483_648 ||
      !Number.isSafeInteger(maximumFiles) ||
      maximumFiles < 1 ||
      maximumFiles > 100_000
    )
      throw new Error("Invalid native queue asset bounds");
    this.#root = resolve(directory);
    this.#allowed = new Map(authorizedPaths.map((path) => [renderPathKey(path), path]));
  }

  async locator(
    locator: RenderMediaLocator,
    extension: string,
    expectedIdentity?: string,
  ): Promise<NativeQueueAsset> {
    if (locator.kind === "inline") {
      const match = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(locator.dataUrl);
      if (!match || match[1].length % 4 || match[1].length > Math.ceil(this.maximumBytes / 3) * 4)
        throw new Error("Invalid bounded inline queue asset");
      return this.inline(Buffer.from(match[1], "base64"), extension, expectedIdentity);
    }
    const url = new URL(locator.url);
    if (url.protocol !== "aster-asset:" || url.hostname !== "local" || url.search || url.hash)
      throw new Error("Queue asset locator is outside the local protocol");
    const requested = decodeURIComponent(url.pathname.slice(1));
    const authorized = this.#allowed.get(renderPathKey(requested));
    if (!authorized) throw new Error("Queue asset is not covered by the media lease");
    const source = await realpath(authorized);
    if (renderPathKey(toNamespacedPath(source)) !== renderPathKey(toNamespacedPath(authorized)))
      throw new Error("Queue asset path changed after authorization");
    const identity = await this.#identity(source);
    this.#assertIdentity(identity, expectedIdentity);
    return this.#store(identity, extension, async (path) =>
      copyFile(source, path, constants.COPYFILE_EXCL),
    );
  }

  async inline(
    bytes: Uint8Array,
    extension: string,
    expectedIdentity?: string,
  ): Promise<NativeQueueAsset> {
    if (bytes.byteLength > this.maximumBytes)
      throw new Error("Queue asset exceeds its byte budget");
    const identity = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteIdentity: new MediaBytesIdentity().update(bytes).digest(),
      bytes: bytes.byteLength,
    };
    this.#assertIdentity(identity, expectedIdentity);
    // Capture the caller's bytes before any asynchronous write can observe a later edit.
    const captured = Buffer.from(bytes);
    return this.#store(identity, extension, async (path) =>
      writeFile(path, captured, { flag: "wx" }),
    );
  }

  #assertIdentity(identity: AssetIdentity, expected?: string): void {
    if (
      (expected?.startsWith("fnv64:") && expected !== identity.byteIdentity) ||
      (expected?.startsWith("sha256:") && expected !== `sha256:${identity.sha256}`)
    )
      throw new Error("Queue asset content identity differs from its snapshot");
  }

  async #identity(path: string): Promise<AssetIdentity> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.maximumBytes)
      throw new Error("Queue asset is not a bounded regular file");
    const sha256 = createHash("sha256"),
      byteIdentity = new MediaBytesIdentity();
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > this.maximumBytes || bytes > info.size)
        throw new Error("Queue asset grew during capture");
      sha256.update(chunk);
      byteIdentity.update(chunk);
    }
    if (bytes !== info.size) throw new Error("Queue asset changed during capture");
    return { sha256: sha256.digest("hex"), byteIdentity: byteIdentity.digest(), bytes };
  }

  #store(
    identity: AssetIdentity,
    extension: string,
    create: (path: string) => Promise<void>,
  ): Promise<NativeQueueAsset> {
    if (!/^\.[a-z0-9]{1,16}$/.test(extension))
      throw new Error("Invalid native queue asset extension");
    const relativePath = `assets/native-queue/${identity.sha256}${extension}`;
    const pending = this.#pending.get(relativePath);
    if (pending)
      return pending.then(async (asset) => {
        const copied = await this.#identity(join(this.#root, relativePath));
        if (copied.sha256 !== identity.sha256 || copied.bytes !== identity.bytes)
          throw new Error("Frozen queue asset changed before reuse");
        return asset;
      });
    if (this.#bytes + identity.bytes > this.maximumBytes || this.#pending.size >= this.maximumFiles)
      throw new Error("Native queue asset store exceeds its budget");
    this.#bytes += identity.bytes;
    const operation = (async (): Promise<NativeQueueAsset> => {
      const directory = join(this.#root, "assets", "native-queue");
      for (const path of [this.#root, join(this.#root, "assets"), directory]) {
        if (path !== this.#root) {
          await mkdir(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        }
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Queue asset store contains a link");
      }
      const destination = join(this.#root, relativePath);
      let created = false;
      try {
        try {
          await create(destination);
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const copied = await this.#identity(destination);
        if (copied.sha256 !== identity.sha256 || copied.bytes !== identity.bytes)
          throw new Error("Queue asset changed while copying");
        return { kind: "relative", relativePath, byteIdentity: identity.byteIdentity };
      } catch (error) {
        if (created) await rm(destination, { force: true });
        throw error;
      }
    })();
    this.#pending.set(relativePath, operation);
    return operation;
  }
}
