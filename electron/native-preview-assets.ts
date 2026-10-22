import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { extname, join, toNamespacedPath } from "node:path";
import type { NativePreviewSnapshot } from "../src/core/rendering/native-preview-protocol.js";
import { renderPathKey } from "./render-queue-paths.js";

/** Preserve legacy bundle assets through authorized, immutable private copies. */
export async function materializePreviewAssets(
  directory: string,
  document: unknown,
  assets: NativePreviewSnapshot["runtimeAssets"],
  allowed: ReadonlyMap<string, string>,
): Promise<void> {
  if (!assets?.length) return;
  const replacements = new Map<string, string>();
  let bytes = 0;
  const destination = join(directory, "assets", "preview");
  await mkdir(destination, { recursive: true });
  for (const asset of assets) {
    const url = new URL(asset.url);
    if (url.protocol !== "aster-asset:" || url.hostname !== "local")
      throw new Error("Preview asset is outside the application asset protocol");
    const requested = decodeURIComponent(url.pathname.slice(1));
    const authorized = allowed.get(renderPathKey(requested));
    if (!authorized) throw new Error("Preview asset was not admitted by this application");
    const source = await realpath(authorized);
    if (renderPathKey(toNamespacedPath(source)) !== renderPathKey(toNamespacedPath(authorized)))
      throw new Error("Preview asset identity changed after admission");
    const info = await stat(source);
    bytes += info.size;
    if (!info.isFile() || bytes > 2147483648)
      throw new Error("Preview assets exceed their byte budget");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    const digest = hash.digest("hex");
    const extension = extname(source).toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/.test(extension))
      throw new Error("Preview asset extension is invalid");
    const relative = `assets/preview/${digest}${extension}`;
    const previous = replacements.get(asset.relativePath);
    if (previous && previous !== relative) throw new Error("Preview asset locators conflict");
    replacements.set(asset.relativePath, relative);
    const target = join(directory, relative);
    try {
      await copyFile(source, target, 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const copied = createHash("sha256");
    for await (const chunk of createReadStream(target)) copied.update(chunk);
    if (copied.digest("hex") !== digest) throw new Error("Preview asset changed while copying");
  }
  const project = document as {
    sources?: Array<{ relativePath?: string }>;
    compositions?: Array<{ layers?: Array<{ asset?: { relativePath?: string } }> }>;
  };
  for (const asset of [
    ...(project.sources ?? []),
    ...(project.compositions ?? []).flatMap((composition) =>
      (composition.layers ?? []).flatMap((layer) => (layer.asset ? [layer.asset] : [])),
    ),
  ]) {
    const replacement = asset.relativePath && replacements.get(asset.relativePath);
    if (replacement) asset.relativePath = replacement;
  }
}
