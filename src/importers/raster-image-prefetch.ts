import { sourceLocator } from "../core/media/footage-source";
import { AsyncWorkPool } from "../core/scheduling/async-work-pool";
import type { Project } from "../core/types";
import { decodeRasterImage, type RasterImageIdentity } from "./raster-image-decoder";

const MAX_PREFETCHED_IMAGES = 24;

/**
 * Bounded lookahead of decoded stills keyed by footage locator. Warming runs before the renderer
 * asks for a source, so the first visible frame already has pixels instead of a placeholder;
 * entries are consumed once and evicted bitmaps are closed to bound decoder memory.
 */
const prefetched = new Map<string, Promise<ImageBitmap>>();
const decodePool = new AsyncWorkPool(2);

export function warmRasterImage(locator: string | undefined, identity: RasterImageIdentity): void {
  if (!locator || prefetched.has(locator)) return;
  const tracked = decodePool
    .run(() =>
      fetch(locator)
        .then((response) => {
          if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => decodeRasterImage(blob, identity)),
    )
    .catch((error: unknown) => {
      if (prefetched.get(locator) === tracked) prefetched.delete(locator);
      throw error;
    });
  prefetched.set(locator, tracked);
  void tracked.catch(() => undefined);
  while (prefetched.size > MAX_PREFETCHED_IMAGES) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    const evicted = prefetched.get(oldest);
    prefetched.delete(oldest);
    void evicted?.then(
      (bitmap) => bitmap.close(),
      () => undefined,
    );
  }
}

/** Begins decoding every still a project references so first presents land on warm cache. */
export function warmProjectRasterSources(project: Project | undefined): void {
  if (!project) return;
  for (const source of project.sources) {
    if (source.kind !== "still") continue;
    warmRasterImage(sourceLocator(source), { name: source.name, mimeType: source.mimeType });
  }
}

/** Transfers a warmed bitmap to the first consumer; later callers fall back to a fresh decode. */
export function takePrefetchedRasterImage(locator: string): Promise<ImageBitmap> | undefined {
  const decode = prefetched.get(locator);
  if (!decode) return undefined;
  prefetched.delete(locator);
  return decode;
}
