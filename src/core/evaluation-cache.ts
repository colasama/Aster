import type { Id } from "./types";

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
  hitRate: number;
}

interface CacheEntry<T> {
  key: EvaluationCacheKey;
  value: T;
}

export class EvaluationCache<T> {
  readonly #capacity: number;
  readonly #entries = new Map<string, CacheEntry<T>>();
  #hits = 0;
  #misses = 0;
  #insertions = 0;
  #evictions = 0;
  #invalidations = 0;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Math.floor(capacity));
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
    this.#insertions += 1;
    this.#entries.delete(id);
    this.#entries.set(id, { key: { ...key }, value });
    if (this.#entries.size <= this.#capacity) return;
    const oldest = this.#entries.keys().next().value;
    if (oldest !== undefined) {
      this.#entries.delete(oldest);
      this.#evictions += 1;
    }
  }

  invalidateNode(nodeId: Id): number {
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.key.nodeId !== nodeId) continue;
      this.#entries.delete(id);
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
      removed += 1;
    }
    this.#invalidations += removed;
    return removed;
  }

  clear(): void {
    this.#invalidations += this.#entries.size;
    this.#entries.clear();
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
