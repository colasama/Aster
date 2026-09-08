import type { Id } from "../types";

export interface EvaluationCacheKey {
  nodeId: Id;
  revision: number;
  time?: number;
  width?: number;
  height?: number;
}

export interface EvaluationCacheStatistics {
  hits: number;
  misses: number;
  insertions: number;
  evictions: number;
  invalidations: number;
  entries: number;
  capacity: number;
  bytes: number;
  maxBytes: number;
  hitRate: number;
}

interface CacheEntry<T> {
  key: EvaluationCacheKey;
  value: T;
  bytes: number;
}

interface EvaluationCacheOptions<T> {
  capacity: number;
  maxBytes: number;
  sizeOf: (value: T) => number;
}

export class EvaluationCache<T> {
  readonly #capacity: number;
  readonly #maxBytes: number;
  readonly #sizeOf: (value: T) => number;
  readonly #entries = new Map<string, CacheEntry<T>>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #insertions = 0;
  #evictions = 0;
  #invalidations = 0;

  constructor(capacityOrOptions: number | EvaluationCacheOptions<T>) {
    const options =
      typeof capacityOrOptions === "number"
        ? { capacity: capacityOrOptions, maxBytes: Number.POSITIVE_INFINITY, sizeOf: () => 0 }
        : capacityOrOptions;
    this.#capacity = Math.max(1, Math.floor(options.capacity));
    this.#maxBytes = Math.max(0, options.maxBytes);
    this.#sizeOf = options.sizeOf;
  }

  get(key: EvaluationCacheKey): T | undefined {
    const id = serializeKey(key);
    const entry = this.#entries.get(id);
    if (!entry) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry.value;
  }

  set(key: EvaluationCacheKey, value: T): void {
    const id = serializeKey(key);
    const existing = this.#entries.get(id);
    if (existing) this.#bytes -= existing.bytes;
    this.#insertions += 1;
    this.#entries.delete(id);
    const bytes = Math.max(0, Math.ceil(this.#sizeOf(value)));
    if (bytes > this.#maxBytes) return;
    this.#entries.set(id, { key: { ...key }, value, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > this.#capacity || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      this.#bytes -= removed?.bytes ?? 0;
      this.#evictions += 1;
    }
  }

  invalidateNode(nodeId: Id): number {
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.key.nodeId !== nodeId) continue;
      this.#entries.delete(id);
      this.#bytes -= entry.bytes;
      removed += 1;
    }
    this.#invalidations += removed;
    return removed;
  }

  invalidateNodes(nodeIds: Iterable<Id>): number {
    const targets = new Set(nodeIds);
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (!targets.has(entry.key.nodeId)) continue;
      this.#entries.delete(id);
      this.#bytes -= entry.bytes;
      removed += 1;
    }
    this.#invalidations += removed;
    return removed;
  }

  clear(): void {
    this.#invalidations += this.#entries.size;
    this.#entries.clear();
    this.#bytes = 0;
  }

  statistics(): EvaluationCacheStatistics {
    const attempts = this.#hits + this.#misses;
    return {
      hits: this.#hits,
      misses: this.#misses,
      insertions: this.#insertions,
      evictions: this.#evictions,
      invalidations: this.#invalidations,
      entries: this.#entries.size,
      capacity: this.#capacity,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      hitRate: attempts === 0 ? 1 : this.#hits / attempts,
    };
  }
}

function serializeKey(key: EvaluationCacheKey): string {
  const time = key.time === undefined ? "static" : normalizeNumber(key.time);
  const resolution =
    key.width === undefined || key.height === undefined
      ? "invariant"
      : `${Math.floor(key.width)}x${Math.floor(key.height)}`;
  return `${key.nodeId}|${Math.floor(key.revision)}|${time}|${resolution}`;
}

function normalizeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Evaluation cache time must be finite");
  return String(Math.round(value * 1_000_000) / 1_000_000);
}
