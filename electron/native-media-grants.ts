import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import { mediaBytesIdentity } from "../src/importers/media-import-identity.js";
import { canonicalNativeMetadata } from "./native-export-input.js";
import { nativeCompositionIdentity } from "./native-job-identity.js";
import { renderPathKey } from "./render-queue-paths.js";

interface NativeMediaGrant {
  source: string;
  scope: string;
  path: string;
  sha256: string;
  sequence_frame?: number;
}

interface FrozenMediaSource {
  id: string;
  kind: string;
  contentIdentity: string;
  dataUrl?: string;
}
interface FrozenMediaLocator {
  kind: string;
  dataUrl?: string;
  url?: string;
}
interface FrozenMediaEntry {
  sourceId: string;
  sourceKind: string;
  contentIdentity: string;
  kind: string;
  locator?: FrozenMediaLocator;
  selection?: {
    frames: { frame: number; file: { byteIdentity?: string; locator: FrozenMediaLocator } }[];
  };
}

/** Creates decoder grants from main-process authorization, never from frame packet locators. */
export class NativeMediaGrants {
  readonly path: string;
  readonly #directory: string;

  private constructor(directory: string) {
    this.#directory = directory;
    this.path = join(directory, "authorizations.json");
  }

  static async create(
    root: string,
    manifest: RenderJobManifest,
    authorizedPaths: readonly string[],
  ): Promise<NativeMediaGrants> {
    await mkdir(root, { recursive: true });
    const owned = new NativeMediaGrants(await mkdtemp(join(root, "aster-native-media-")));
    try {
      const grants = await owned.#collect(manifest, authorizedPaths);
      const encoded = JSON.stringify(grants);
      if (Buffer.byteLength(encoded) > 64 * 1024 * 1024)
        throw new Error("Native media grants exceed their byte limit");
      await writeFile(owned.path, encoded, { flag: "wx", mode: 0o600 });
      return owned;
    } catch (error) {
      await owned.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  async #collect(
    manifest: RenderJobManifest,
    authorizedPaths: readonly string[],
  ): Promise<NativeMediaGrant[]> {
    const project = JSON.parse(manifest.projectSnapshot) as { sources: FrozenMediaSource[] };
    const media = JSON.parse(
      manifest.renderMediaSnapshot ?? '{"version":1,"entries":[],"payloads":[]}',
    ) as { version: number; entries: FrozenMediaEntry[] };
    if (
      !Array.isArray(project.sources) ||
      media.version !== 1 ||
      !Array.isArray(media.entries) ||
      media.entries.length > 100_000
    )
      throw new Error("Native media snapshot is invalid");
    const scope = `render-job:${manifest.id}`;
    const authorized = new Map(authorizedPaths.map((path) => [renderPathKey(path), path]));
    const entries = new Map(media.entries.map((entry) => [entry.sourceId, entry]));
    if (entries.size !== media.entries.length) throw new Error("Native media source is duplicated");
    const inline = new Map<string, string>();
    const grants = new Map<string, NativeMediaGrant>();
    let inlineBytes = 0;
    const locate = async (locator: FrozenMediaLocator, identity: string) => {
      if (locator.kind === "inline") {
        const data = locator.dataUrl;
        if (typeof data !== "string" || data.length > 90 * 1024 * 1024)
          throw new Error("Native inline media exceeds its byte limit");
        const comma = data.indexOf(",");
        if (comma < 0 || !/^data:[^,;]+;base64$/i.test(data.slice(0, comma)))
          throw new Error("Native inline media requires a base64 data URL");
        const encoded = data.slice(comma + 1);
        if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
          throw new Error("Native inline media base64 is invalid");
        if (Math.floor((encoded.length * 3) / 4) > 64 * 1024 * 1024 - inlineBytes)
          throw new Error("Native inline media exceeds its aggregate byte limit");
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded)
          throw new Error("Native inline media base64 is not canonical");
        inlineBytes += bytes.length;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (identity !== `sha256:${sha256}` && identity !== mediaBytesIdentity(bytes))
          throw new Error("Native inline media identity mismatch");
        let path = inline.get(sha256);
        if (!path) {
          path = join(this.#directory, `${sha256}.media`);
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
          inline.set(sha256, path);
        }
        return { path, sha256 };
      }
      if (
        locator.kind !== "bundle" ||
        typeof locator.url !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(identity)
      )
        throw new Error("Native linked media needs an authorized immutable SHA-256 snapshot");
      const url = new URL(locator.url);
      const decoded = decodeURIComponent(url.pathname.slice(1));
      const path =
        url.protocol === "aster-asset:" && url.hostname === "local" && isAbsolute(decoded)
          ? authorized.get(renderPathKey(resolve(decoded)))
          : undefined;
      if (!path) throw new Error("Native media path is outside the job authorization lease");
      return { path, sha256: identity.slice(7) };
    };
    for (const source of project.sources) {
      if (source.kind !== "still" && source.kind !== "video" && source.kind !== "imageSequence")
        continue;
      if (
        typeof source.id !== "string" ||
        !source.id ||
        typeof source.contentIdentity !== "string" ||
        !source.contentIdentity
      )
        throw new Error("Native media source identity is invalid");
      const entry = entries.get(source.id);
      if (!entry && !source.dataUrl) continue; // Unreferenced sources have no decoder grant.
      if (
        entry &&
        (entry.sourceKind !== source.kind || entry.contentIdentity !== source.contentIdentity)
      )
        throw new Error("Native media entry disagrees with the frozen project source");
      const descriptor = {
        source_id: nativeCompositionIdentity(source.id),
        content_identity: source.contentIdentity,
        authorization_scope: scope,
        media_kind:
          source.kind === "still" ? "image" : source.kind === "video" ? "video" : "sequence",
      };
      const metadata = Buffer.from(canonicalNativeMetadata({ kind: "media_source", descriptor }));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(metadata.length);
      const hash = createHash("sha256")
        .update("ASTER_RESOURCE_V1\0")
        .update(length)
        .update(metadata)
        .digest("hex");
      const add = async (
        locator: Parameters<typeof locate>[0],
        identity: string,
        sequenceFrame?: number,
      ) => {
        if (
          grants.size >= 100_000 ||
          (sequenceFrame !== undefined &&
            (!Number.isSafeInteger(sequenceFrame) || sequenceFrame < 0))
        )
          throw new Error("Native media grant count or sequence frame is invalid");
        const key = `${hash}:${sequenceFrame ?? "source"}`;
        if (grants.has(key)) throw new Error("Native media grant is duplicated");
        grants.set(key, {
          source: hash,
          scope,
          ...(await locate(locator, identity)),
          ...(sequenceFrame === undefined ? {} : { sequence_frame: sequenceFrame }),
        });
      };
      if (source.kind === "imageSequence") {
        if (entry?.kind !== "imageSequence" || !Array.isArray(entry.selection?.frames))
          throw new Error("Native sequence snapshot is missing");
        for (const frame of entry.selection.frames) {
          if (!frame.file.byteIdentity)
            throw new Error("Native sequence member identity is missing");
          await add(frame.file.locator, frame.file.byteIdentity, frame.frame);
        }
      } else if (source.dataUrl)
        await add({ kind: "inline", dataUrl: source.dataUrl }, source.contentIdentity);
      else if (entry?.kind === "locator" && entry.locator)
        await add(entry.locator, source.contentIdentity);
      else throw new Error("Native file media locator is missing");
    }
    return [...grants.values()];
  }
}
