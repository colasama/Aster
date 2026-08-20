export const MAX_CHECKPOINT_CACHE_BYTES = 512 * 1024 * 1024;
export const MAX_CHECKPOINT_ENTRIES = 4_096;
export const MAX_SIMULATION_FRAME = 0x7fff_ffff;

export interface SimulationCheckpointCacheOptions {
  checkpointIntervalFrames?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxForwardReplayFrames?: number;
}

export interface SimulationCheckpoint {
  frame: number;
  state: Uint8Array;
  streamId: string;
}

export type SimulationSeekPlan =
  | { mode: "continue"; replayFromFrame: number; replayFrames: number }
  | { mode: "restore"; checkpoint: SimulationCheckpoint; replayFrames: number }
  | { mode: "restart"; replayFromFrame: 0; replayFrames: number };

export interface SimulationCheckpointStatistics {
  bytes: number;
  entries: number;
  evictions: number;
  hits: number;
  misses: number;
}

interface StoredCheckpoint {
  frame: number;
  lastUse: number;
  state: Uint8Array;
  streamId: string;
}

/**
 * Bounded CPU-side snapshots for iterative simulations that cannot evaluate an
 * arbitrary frame analytically. GPU buffers can be copied into the byte state
 * asynchronously, then restored before replaying only the remaining frames.
 */
export class SimulationCheckpointCache {
  readonly #checkpointIntervalFrames: number;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #maxForwardReplayFrames: number;
  readonly #entries = new Map<string, StoredCheckpoint>();
  #bytes = 0;
  #clock = 0;
  #evictions = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: SimulationCheckpointCacheOptions = {}) {
    this.#checkpointIntervalFrames = boundedInteger(
      "checkpointIntervalFrames",
      options.checkpointIntervalFrames ?? 120,
      1,
      MAX_SIMULATION_FRAME,
    );
    this.#maxBytes = boundedInteger(
      "maxBytes",
      options.maxBytes ?? 64 * 1024 * 1024,
      1,
      MAX_CHECKPOINT_CACHE_BYTES,
    );
    this.#maxEntries = boundedInteger(
      "maxEntries",
      options.maxEntries ?? 256,
      1,
      MAX_CHECKPOINT_ENTRIES,
    );
    this.#maxForwardReplayFrames = boundedInteger(
      "maxForwardReplayFrames",
      options.maxForwardReplayFrames ?? 8,
      0,
      MAX_SIMULATION_FRAME,
    );
  }

  shouldCapture(frame: number): boolean {
    requireFrame(frame);
    return frame % this.#checkpointIntervalFrames === 0;
  }

  capture(streamId: string, frame: number, state: Uint8Array): boolean {
    requireStreamId(streamId);
    requireFrame(frame);
    if (state.byteLength === 0) throw new Error("checkpoint state must not be empty");
    if (state.byteLength > this.#maxBytes) return false;

    const key = checkpointKey(streamId, frame);
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.state.byteLength;
      this.#entries.delete(key);
    }
    const copy = state.slice();
    this.#entries.set(key, { frame, lastUse: ++this.#clock, state: copy, streamId });
    this.#bytes += copy.byteLength;
    this.#evictToBudget();
    return this.#entries.has(key);
  }

  nearest(streamId: string, targetFrame: number): SimulationCheckpoint | undefined {
    requireStreamId(streamId);
    requireFrame(targetFrame);
    let nearest: StoredCheckpoint | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.streamId !== streamId || entry.frame > targetFrame) continue;
      if (!nearest || entry.frame > nearest.frame) nearest = entry;
    }
    if (!nearest) {
      this.#misses += 1;
      return undefined;
    }
    nearest.lastUse = ++this.#clock;
    this.#hits += 1;
    return cloneCheckpoint(nearest);
  }

  planSeek(streamId: string, targetFrame: number, currentFrame?: number): SimulationSeekPlan {
    requireStreamId(streamId);
    requireFrame(targetFrame);
    if (currentFrame !== undefined) {
      requireFrame(currentFrame);
      const replayFrames = targetFrame - currentFrame;
      if (replayFrames >= 0 && replayFrames <= this.#maxForwardReplayFrames) {
        return { mode: "continue", replayFromFrame: currentFrame, replayFrames };
      }
    }
    const checkpoint = this.nearest(streamId, targetFrame);
    if (checkpoint) {
      return {
        mode: "restore",
        checkpoint,
        replayFrames: targetFrame - checkpoint.frame,
      };
    }
    return { mode: "restart", replayFromFrame: 0, replayFrames: targetFrame };
  }

  invalidateAfter(streamId: string, frame: number): void {
    requireStreamId(streamId);
    requireFrame(frame);
    for (const [key, entry] of this.#entries) {
      if (entry.streamId === streamId && entry.frame > frame) this.#remove(key, entry);
    }
  }

  invalidateStream(streamId: string): void {
    requireStreamId(streamId);
    for (const [key, entry] of this.#entries) {
      if (entry.streamId === streamId) this.#remove(key, entry);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  statistics(): SimulationCheckpointStatistics {
    return {
      bytes: this.#bytes,
      entries: this.#entries.size,
      evictions: this.#evictions,
      hits: this.#hits,
      misses: this.#misses,
    };
  }

  #evictToBudget(): void {
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      let oldest: [string, StoredCheckpoint] | undefined;
      for (const candidate of this.#entries) {
        if (!oldest || candidate[1].lastUse < oldest[1].lastUse) oldest = candidate;
      }
      if (!oldest) return;
      this.#remove(oldest[0], oldest[1]);
      this.#evictions += 1;
    }
  }

  #remove(key: string, entry: StoredCheckpoint): void {
    if (!this.#entries.delete(key)) return;
    this.#bytes -= entry.state.byteLength;
  }
}

function cloneCheckpoint(checkpoint: StoredCheckpoint): SimulationCheckpoint {
  return {
    frame: checkpoint.frame,
    state: checkpoint.state.slice(),
    streamId: checkpoint.streamId,
  };
}

function checkpointKey(streamId: string, frame: number): string {
  return `${streamId}\u0000${frame}`;
}

function requireFrame(frame: number): void {
  boundedInteger("frame", frame, 0, MAX_SIMULATION_FRAME);
}

function requireStreamId(streamId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(streamId)) {
    throw new Error("streamId must be a bounded stable identifier");
  }
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
