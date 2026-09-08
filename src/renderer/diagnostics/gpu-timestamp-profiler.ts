import type { GpuPassTimings } from "../../core/types";

const QUERY_COUNT = 8;
const QUERY_BYTES = QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;

export class GpuTimestampProfiler {
  readonly #querySet?: GPUQuerySet;
  readonly #resolveBuffer?: GPUBuffer;
  readonly #readBuffer?: GPUBuffer;
  readonly #invalidate: () => void;
  #pending = false;
  #totalMs?: number;
  #passTimings?: GpuPassTimings;

  constructor(device: GPUDevice, enabled: boolean, invalidate: () => void) {
    this.#invalidate = invalidate;
    if (!enabled) return;
    this.#querySet = device.createQuerySet({
      label: "Aster GPU pass timestamps",
      type: "timestamp",
      count: QUERY_COUNT,
    });
    this.#resolveBuffer = device.createBuffer({
      label: "GPU timestamp resolve",
      size: QUERY_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.#readBuffer = device.createBuffer({
      label: "Asynchronous GPU timestamp readback",
      size: QUERY_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  writes(beginningOfPassWriteIndex?: number, endOfPassWriteIndex?: number) {
    if (!this.#querySet) return undefined;
    return {
      querySet: this.#querySet,
      beginningOfPassWriteIndex,
      endOfPassWriteIndex,
    };
  }

  encodeReadback(encoder: GPUCommandEncoder): boolean {
    if (!this.#querySet || !this.#resolveBuffer || !this.#readBuffer || this.#pending) return false;
    this.#pending = true;
    encoder.resolveQuerySet(this.#querySet, 0, QUERY_COUNT, this.#resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.#resolveBuffer, 0, this.#readBuffer, 0, QUERY_BYTES);
    return true;
  }

  readback(): void {
    const buffer = this.#readBuffer;
    if (!buffer) return;
    void buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const firstSample = this.#passTimings === undefined;
        const timestamps = new BigUint64Array(buffer.getMappedRange().slice(0));
        const compute = timestamps[1] - timestamps[0];
        const shadow = timestamps[3] - timestamps[2];
        const scene = timestamps[5] - timestamps[4];
        const post = timestamps[7] - timestamps[6];
        this.#totalMs = Number(compute + shadow + scene + post) / 1_000_000;
        this.#passTimings = {
          computeMs: Number(compute) / 1_000_000,
          shadowMs: Number(shadow) / 1_000_000,
          sceneMs: Number(scene) / 1_000_000,
          postMs: Number(post) / 1_000_000,
        };
        buffer.unmap();
        if (firstSample) this.#invalidate();
      })
      .catch(() => undefined)
      .finally(() => {
        this.#pending = false;
      });
  }

  totalMs(): number | undefined {
    return this.#totalMs;
  }

  passTimings(): GpuPassTimings | undefined {
    return this.#passTimings;
  }

  destroy(): void {
    if (this.#readBuffer?.mapState === "mapped") this.#readBuffer.unmap();
    this.#querySet?.destroy();
    this.#resolveBuffer?.destroy();
    this.#readBuffer?.destroy();
    this.#pending = false;
  }
}
