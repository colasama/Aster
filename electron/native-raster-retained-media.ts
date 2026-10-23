import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { mediaBytesIdentity } from "../src/importers/media-import-identity.js";
import {
  MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS,
  parseRenderMediaManifest,
} from "../src/render-queue/render-media-codec.js";

/** Admit only authenticated, job-local PSD pixels; this sidecar grants no file access. */
export async function readRetainedQueueMedia(
  project: string,
  input: { path: string; sha256: string },
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid retained media digest");
  const root = dirname(await realpath(project));
  const path = await realpath(input.path),
    member = relative(root, path);
  if (
    !member ||
    member === ".." ||
    member.startsWith(`..\\`) ||
    member.startsWith("../") ||
    isAbsolute(member)
  )
    throw new Error("Retained media must be inside its project directory");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS || info.size < 2)
      throw new Error("Invalid retained media size");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (
      length !== info.size ||
      createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== input.sha256
    )
      throw new Error("Retained media identity changed");
    const snapshot = bytes.subarray(0, length).toString("utf8");
    const manifest = parseRenderMediaManifest(snapshot);
    const payloads = new Map(manifest.payloads.map((payload) => [payload.id, payload]));
    const used = new Set<string>();
    for (const entry of manifest.entries) {
      if (entry.kind !== "psd" || !entry.fallback)
        throw new Error("Retained queue media must contain only PSD fallback pixels");
      const payload = payloads.get(entry.payloadId);
      if (payload?.kind !== "rgba") throw new Error("Retained PSD pixels are missing");
      const pixels = Buffer.from(payload.bytes, "base64");
      if (
        pixels.length !== entry.decodedWidth * entry.decodedHeight * 4 ||
        mediaBytesIdentity(pixels) !== payload.identity
      )
        throw new Error("Retained PSD pixel identity or dimensions differ");
      used.add(payload.id);
    }
    if (!used.size || used.size !== payloads.size)
      throw new Error("Retained PSD payload coverage differs");
    return snapshot;
  } finally {
    await file.close();
  }
}
