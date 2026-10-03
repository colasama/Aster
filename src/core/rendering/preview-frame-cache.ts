import { DEFAULT_FRAME_CACHE_BUDGET_MB } from "./frame-cache-policy";

const MIB = 1024 * 1024;
const NOTIFY_INTERVAL_MS = 100;

export interface CachedPreviewFrame {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  /** Packed 8-bit order of the canvas texture the frame was read from. */
  pixelFormat: "bgra" | "rgba";
}

export interface PreviewFrameCacheUsage {
  usedBytes: number;
  budgetBytes: number;
  frameCount: number;
}

export interface CachedFrameRange {
  start: number;
  count: number;
}

interface Entry {
  compositionId: string;
  scope: string;
  frame: number;
  data: CachedPreviewFrame;
}

/**
 * Finished preview frames in RAM, least recently used first. A scope names every input of a
 * frame except its index; each composition has one active scope, so the first lookup after an
 * edit drops frames that can never be shown again.
 */
export class PreviewFrameCache {
  readonly #entries = new Map<string, Entry>();
  readonly #activeScopes = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #schedule: (notify: () => void) => void;
  #budgetBytes: number;
  #usedBytes = 0;
  #revision = 0;
  #notifyPending = false;
  #framesMemo = new Map<string, { revision: number; frames: readonly number[] }>();

  constructor(
    budgetMb = DEFAULT_FRAME_CACHE_BUDGET_MB,
    schedule: (notify: () => void) => void = (notify) => {
      setTimeout(notify, NOTIFY_INTERVAL_MS);
    },
  ) {
    this.#budgetBytes = Math.max(0, budgetMb) * MIB;
    this.#schedule = schedule;
  }

  get enabled(): boolean {
    return this.#budgetBytes > 0;
  }

  get revision(): number {
    return this.#revision;
  }

  usage(): PreviewFrameCacheUsage {
    return {
      usedBytes: this.#usedBytes,
      budgetBytes: this.#budgetBytes,
      frameCount: this.#entries.size,
    };
  }

  setBudgetMb(budgetMb: number): void {
    const budgetBytes = Math.max(0, budgetMb) * MIB;
    if (budgetBytes === this.#budgetBytes) return;
    this.#budgetBytes = budgetBytes;
    this.#evictToBudget();
    this.#changed();
  }

  /** Marks `scope` current for the composition and discards frames of any older scope. */
  activate(compositionId: string, scope: string): void {
    if (this.#activeScopes.get(compositionId) === scope) return;
    this.#activeScopes.set(compositionId, scope);
    let removed = false;
    for (const [key, entry] of this.#entries)
      if (entry.compositionId === compositionId && entry.scope !== scope) {
        this.#remove(key, entry);
        removed = true;
      }
    if (removed) this.#changed();
  }

  lookup(compositionId: string, scope: string, frame: number): CachedPreviewFrame | undefined {
    this.activate(compositionId, scope);
    const key = entryKey(scope, frame);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.data;
  }

  /** Stores a finished frame; captures that finish after an edit changed the scope are dropped. */
  store(compositionId: string, scope: string, frame: number, data: CachedPreviewFrame): boolean {
    const bytes = data.pixels.byteLength;
    if (!this.enabled || bytes > this.#budgetBytes) return false;
    if (this.#activeScopes.get(compositionId) !== scope) return false;
    const key = entryKey(scope, frame);
    const existing = this.#entries.get(key);
    if (existing) this.#remove(key, existing);
    this.#entries.set(key, { compositionId, scope, frame, data });
    this.#usedBytes += bytes;
    this.#evictToBudget();
    this.#changed();
    return true;
  }

  clear(): void {
    if (this.#entries.size === 0) return;
    this.#entries.clear();
    this.#usedBytes = 0;
    this.#changed();
  }

  /** Sorted frame indices cached for the composition's active scope. */
  cachedFrames(compositionId: string): readonly number[] {
    const memo = this.#framesMemo.get(compositionId);
    if (memo?.revision === this.#revision) return memo.frames;
    const scope = this.#activeScopes.get(compositionId);
    const frames: number[] = [];
    for (const entry of this.#entries.values())
      if (entry.compositionId === compositionId && entry.scope === scope) frames.push(entry.frame);
    frames.sort((left, right) => left - right);
    this.#framesMemo.set(compositionId, { revision: this.#revision, frames });
    return frames;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #evictToBudget(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#usedBytes <= this.#budgetBytes) break;
      this.#remove(key, entry);
    }
  }

  #remove(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#usedBytes -= entry.data.pixels.byteLength;
  }

  #changed(): void {
    this.#revision += 1;
    if (this.#notifyPending) return;
    this.#notifyPending = true;
    this.#schedule(() => {
      this.#notifyPending = false;
      for (const listener of this.#listeners) listener();
    });
  }
}

/** Collapses sorted frame indices into contiguous runs for the timeline indicator. */
export function cachedFrameRanges(frames: readonly number[]): CachedFrameRange[] {
  const ranges: CachedFrameRange[] = [];
  for (const frame of frames) {
    const last = ranges[ranges.length - 1];
    if (last && frame === last.start + last.count) last.count += 1;
    else if (!last || frame > last.start + last.count - 1) ranges.push({ start: frame, count: 1 });
  }
  return ranges;
}

function entryKey(scope: string, frame: number): string {
  return `${scope}\u0000${frame}`;
}

/** The editor's shared preview cache: the viewport fills it and the timeline displays it. */
export const previewFrameCache = new PreviewFrameCache();
