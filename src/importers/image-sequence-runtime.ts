import {
  type ImageSequenceFrame,
  type ImageSequenceSelection,
  type SequenceFileLike,
  sequenceFrameAtTime,
} from "./image-sequence";

export type MissingSequenceFramePolicy = "error" | "holdPrevious" | "nearest";

export interface ResolvedSequenceFrame<FileType extends SequenceFileLike = SequenceFileLike> {
  requestedFrame: number;
  actualFrame: number;
  missing: boolean;
  file: FileType;
}

export interface SequenceFrameCacheOptions<FileType extends SequenceFileLike, DecodedType> {
  decode: (file: FileType) => Promise<DecodedType>;
  estimateBytes: (value: DecodedType) => number;
  dispose?: (value: DecodedType) => void;
  maxEntries?: number;
  maxBytes?: number;
}

interface ReadyEntry<DecodedType> {
  value: DecodedType;
  bytes: number;
  stamp: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** Resolves an exact or policy-selected sequence frame with logarithmic lookup. */
export function resolveImageSequenceFrame<FileType extends SequenceFileLike>(
  sequence: ImageSequenceSelection<FileType>,
  time: number,
  frameRate: { numerator: number; denominator: number },
  options: { loop?: boolean; missingFramePolicy?: MissingSequenceFramePolicy } = {},
): ResolvedSequenceFrame<FileType> {
  if (sequence.frames.length === 0) throw new Error("Image sequence has no available frames");
  const requestedFrame = sequenceFrameAtTime(sequence, time, frameRate, options.loop);
  const insertion = lowerBound(sequence.frames, requestedFrame);
  const exact = sequence.frames[insertion];
  if (exact?.frame === requestedFrame)
    return { requestedFrame, actualFrame: requestedFrame, missing: false, file: exact.file };
  const policy = options.missingFramePolicy ?? "holdPrevious";
  if (policy === "error") throw new Error(`Image sequence frame ${requestedFrame} is missing`);
  const before = sequence.frames[Math.max(0, insertion - 1)];
  const after = sequence.frames[Math.min(sequence.frames.length - 1, insertion)];
  const selected =
    policy === "holdPrevious" ? (before ?? after) : nearestFrame(requestedFrame, before, after);
  if (!selected) throw new Error("Image sequence has no resolvable frame");
  return {
    requestedFrame,
    actualFrame: selected.frame,
    missing: true,
    file: selected.file,
  };
}

/** Bounded, reload-safe LRU cache that deduplicates concurrent frame decodes. */
export class ImageSequenceFrameCache<FileType extends SequenceFileLike, DecodedType> {
  readonly #decode: (file: FileType) => Promise<DecodedType>;
  readonly #estimateBytes: (value: DecodedType) => number;
  readonly #dispose?: (value: DecodedType) => void;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ready = new Map<string, ReadyEntry<DecodedType>>();
  readonly #pending = new Map<string, Promise<DecodedType>>();
  #bytes = 0;
  #stamp = 0;

  constructor(options: SequenceFrameCacheOptions<FileType, DecodedType>) {
    this.#decode = options.decode;
    this.#estimateBytes = options.estimateBytes;
    this.#dispose = options.dispose;
    this.#maxEntries = boundedInteger(options.maxEntries, 1, 512, DEFAULT_MAX_ENTRIES);
    this.#maxBytes = boundedInteger(options.maxBytes, 1, 4 * 1024 * 1024 * 1024, DEFAULT_MAX_BYTES);
  }

  get size(): number {
    return this.#ready.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  async get(frame: ImageSequenceFrame<FileType>): Promise<DecodedType> {
    const key = frameCacheKey(frame);
    const ready = this.#ready.get(key);
    if (ready) {
      ready.stamp = ++this.#stamp;
      return ready.value;
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const decoded = this.#decode(frame.file).then(
      (value) => {
        this.#pending.delete(key);
        const estimate = this.#estimateBytes(value);
        const bytes = Number.isFinite(estimate) && estimate >= 0 ? Math.floor(estimate) : 0;
        if (bytes > this.#maxBytes) return value;
        this.#ready.set(key, { value, bytes, stamp: ++this.#stamp });
        this.#bytes += bytes;
        this.#evict();
        return value;
      },
      (error: unknown) => {
        this.#pending.delete(key);
        throw error;
      },
    );
    this.#pending.set(key, decoded);
    return decoded;
  }

  /** Preloads nearest frames first with bounded decode concurrency. */
  async preload(
    frames: readonly ImageSequenceFrame<FileType>[],
    centerFrame: number,
    radius: number,
    concurrency = 2,
  ): Promise<void> {
    const boundedRadius = boundedInteger(radius, 0, 512, 0);
    const queue = frames
      .filter((frame) => Math.abs(frame.frame - centerFrame) <= boundedRadius)
      .sort(
        (left, right) =>
          Math.abs(left.frame - centerFrame) - Math.abs(right.frame - centerFrame) ||
          left.frame - right.frame,
      );
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const frame = queue[cursor++];
        if (frame) await this.get(frame);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(queue.length, boundedInteger(concurrency, 1, 8, 2)) }, worker),
    );
  }

  invalidate(frame: ImageSequenceFrame<FileType>): void {
    this.#remove(frameCacheKey(frame));
  }

  clear(): void {
    for (const key of [...this.#ready.keys()]) this.#remove(key);
  }

  #evict(): void {
    while (this.#ready.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      let oldestKey: string | undefined;
      let oldestStamp = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#ready)
        if (entry.stamp < oldestStamp) {
          oldestKey = key;
          oldestStamp = entry.stamp;
        }
      if (!oldestKey) break;
      this.#remove(oldestKey);
    }
  }

  #remove(key: string): void {
    const entry = this.#ready.get(key);
    if (!entry) return;
    this.#ready.delete(key);
    this.#bytes -= entry.bytes;
    this.#dispose?.(entry.value);
  }
}

function lowerBound<FileType extends SequenceFileLike>(
  frames: readonly ImageSequenceFrame<FileType>[],
  frame: number,
): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((frames[middle]?.frame ?? Number.POSITIVE_INFINITY) < frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearestFrame<FileType extends SequenceFileLike>(
  requested: number,
  before: ImageSequenceFrame<FileType> | undefined,
  after: ImageSequenceFrame<FileType> | undefined,
): ImageSequenceFrame<FileType> | undefined {
  if (!before) return after;
  if (!after) return before;
  return requested - before.frame <= after.frame - requested ? before : after;
}

function frameCacheKey<FileType extends SequenceFileLike>(
  frame: ImageSequenceFrame<FileType>,
): string {
  const file = frame.file;
  return `${frame.frame}|${file.name}|${file.size}|${file.lastModified}|${file.type}`;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.floor(Math.min(maximum, Math.max(minimum, normalized)));
}
