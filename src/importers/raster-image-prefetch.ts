import { sourceLocator } from "../core/media/footage-source";
import { AsyncWorkPool } from "../core/scheduling/async-work-pool";
import type { FootageSource, Project } from "../core/types";
import { decodeRasterImage, type RasterImageIdentity } from "./raster-image-decoder";

const MAX_PREFETCHED_IMAGES = 24;
const MAX_WARMED_LOCATORS = 4_096;

interface PrefetchState {
  started: boolean;
  cancelled: boolean;
}

interface PrefetchEntry {
  readonly decode: Promise<ImageBitmap>;
  readonly state: PrefetchState;
}

/**
 * Bounded lookahead of decoded stills keyed by footage locator. Warming runs before the renderer
 * asks for a source, so the first visible frame already has pixels instead of a placeholder;
 * entries are consumed once and evicted bitmaps are closed to bound decoder memory.
 */
const prefetched = new Map<string, PrefetchEntry>();
/**
 * Locators already warmed once. An evicted or consumed locator is never queued again: re-warming
 * on every render would keep the bounded decode pool permanently busy with images that are
 * evicted again before use, starving the stills the current frame is waiting for.
 */
const warmed = new Set<string>();
const decodePool = new AsyncWorkPool(2);

export function warmRasterImage(locator: string | undefined, identity: RasterImageIdentity): void {
  if (!locator || warmed.has(locator)) return;
  if (warmed.size >= MAX_WARMED_LOCATORS) warmed.clear();
  warmed.add(locator);
  const state: PrefetchState = { started: false, cancelled: false };
  const decode = decodePool
    .run(() => {
      if (state.cancelled) return Promise.reject(new Error("Raster prefetch was cancelled"));
      state.started = true;
      return fetch(locator)
        .then((response) => {
          if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => decodeRasterImage(blob, identity));
    })
    .catch((error: unknown) => {
      if (prefetched.get(locator)?.state === state) prefetched.delete(locator);
      throw error;
    });
  prefetched.set(locator, { decode, state });
  void decode.catch(() => undefined);
  while (prefetched.size > MAX_PREFETCHED_IMAGES) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    const evicted = prefetched.get(oldest);
    prefetched.delete(oldest);
    if (!evicted) continue;
    evicted.state.cancelled = true;
    void evicted.decode.then(
      (bitmap) => bitmap.close(),
      () => undefined,
    );
  }
}

/**
 * Begins decoding the stills a project uses, earliest on the timeline first and at most as many
 * as the prefetch cache holds, so the opening frames land on warm cache before later media.
 */
export function warmProjectRasterSources(project: Project | undefined): void {
  if (!project) return;
  const firstUse = new Map<string, number>();
  for (const composition of project.compositions)
    for (const layer of composition.layers)
      if (layer.sourceId)
        firstUse.set(
          layer.sourceId,
          Math.min(firstUse.get(layer.sourceId) ?? Number.POSITIVE_INFINITY, layer.inPoint),
        );
  const stills = project.sources
    .filter((source): source is FootageSource => source.kind === "still")
    .map((source, index) => ({ source, index, at: firstUse.get(source.id) }))
    .sort(
      (a, b) =>
        (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index,
    )
    .slice(0, MAX_PREFETCHED_IMAGES);
  for (const { source } of stills)
    warmRasterImage(sourceLocator(source), { name: source.name, mimeType: source.mimeType });
}

/**
 * Transfers a warmed bitmap to the first consumer. A warm that has not started decoding yet is
 * cancelled instead, so the caller decodes immediately rather than waiting behind the background
 * queue; later callers fall back to a fresh decode.
 */
export function takePrefetchedRasterImage(locator: string): Promise<ImageBitmap> | undefined {
  const entry = prefetched.get(locator);
  if (!entry) return undefined;
  prefetched.delete(locator);
  if (entry.state.started) return entry.decode;
  entry.state.cancelled = true;
  return undefined;
}

/** Test hook: forgets warmed locators and closes cached bitmaps. */
export function resetRasterImagePrefetch(): void {
  for (const entry of prefetched.values()) {
    entry.state.cancelled = true;
    void entry.decode.then(
      (bitmap) => bitmap.close(),
      () => undefined,
    );
  }
  prefetched.clear();
  warmed.clear();
}
