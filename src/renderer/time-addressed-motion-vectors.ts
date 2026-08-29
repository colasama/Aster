import {
  FLOATS_PER_VERTEX,
  type GeometryBatch,
  type GeometryResult,
  VERTEX_FLOAT_OFFSETS,
} from "./geometry";

const MOTION_VECTOR_FLOATS = 2;
const MOTION_VECTOR_BYTES = MOTION_VECTOR_FLOATS * Float32Array.BYTES_PER_ELEMENT;

/**
 * Builds shutter-open to shutter-close UV displacement without consulting render history. Stable
 * instance IDs and equal vertex counts are required; topology changes safely produce zero velocity.
 */
export function buildTimeAddressedMotionVectors(
  current: GeometryResult,
  shutterOpen: GeometryResult,
  shutterClose: GeometryResult,
  enabledSelectionIds?: ReadonlySet<string>,
): Float32Array {
  const vertexCount = current.data.length / FLOATS_PER_VERTEX;
  if (!Number.isSafeInteger(vertexCount))
    throw new Error("Current motion-vector geometry is not vertex aligned");
  const output = new Float32Array(vertexCount * MOTION_VECTOR_FLOATS);
  const openByIdentity = batchMap(shutterOpen.batches);
  const closeByIdentity = batchMap(shutterClose.batches);
  for (const currentBatch of current.batches) {
    if (enabledSelectionIds && !enabledSelectionIds.has(currentBatch.selectionId)) continue;
    const identity = batchIdentity(currentBatch);
    const openBatch = openByIdentity.get(identity);
    const closeBatch = closeByIdentity.get(identity);
    if (
      !openBatch ||
      !closeBatch ||
      openBatch.vertexCount !== currentBatch.vertexCount ||
      closeBatch.vertexCount !== currentBatch.vertexCount
    )
      continue;
    for (let localVertex = 0; localVertex < currentBatch.vertexCount; localVertex += 1) {
      const currentVertex = currentBatch.firstVertex + localVertex;
      const openVertex = openBatch.firstVertex + localVertex;
      const closeVertex = closeBatch.firstVertex + localVertex;
      const openOffset = openVertex * FLOATS_PER_VERTEX + VERTEX_FLOAT_OFFSETS.position;
      const closeOffset = closeVertex * FLOATS_PER_VERTEX + VERTEX_FLOAT_OFFSETS.position;
      const outputOffset = currentVertex * MOTION_VECTOR_FLOATS;
      output[outputOffset] = finiteDisplacement(
        (shutterClose.data[closeOffset] - shutterOpen.data[openOffset]) * 0.5,
      );
      output[outputOffset + 1] = finiteDisplacement(
        (shutterClose.data[closeOffset + 1] - shutterOpen.data[openOffset + 1]) * -0.5,
      );
    }
  }
  return output;
}

/** GPU-resident endpoint vector storage; reallocation is power-of-two and amortized. */
export class GpuTimeAddressedMotionVectors {
  readonly #device: GPUDevice;
  #buffer?: GPUBuffer;
  #capacityBytes = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  get estimatedBytes(): number {
    return this.#capacityBytes;
  }

  plannedBytes(vertexCount: number): number {
    return Math.max(this.#capacityBytes, motionVectorBufferBytes(vertexCount));
  }

  upload(vectors: Float32Array): GPUBuffer {
    if (vectors.length % MOTION_VECTOR_FLOATS !== 0)
      throw new Error("Motion vectors must contain one XY pair per vertex");
    const required = motionVectorBufferBytes(vectors.length / MOTION_VECTOR_FLOATS);
    if (!this.#buffer || required > this.#capacityBytes) {
      this.#buffer?.destroy();
      this.#capacityBytes = required;
      this.#buffer = this.#device.createBuffer({
        label: "Time-addressed shutter endpoint vectors",
        size: required,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (vectors.byteLength > 0) this.#device.queue.writeBuffer(this.#buffer, 0, vectors);
    return this.#buffer;
  }

  release(): void {
    this.#buffer?.destroy();
    this.#buffer = undefined;
    this.#capacityBytes = 0;
  }

  destroy(): void {
    this.release();
  }
}

export function motionVectorBufferBytes(vertexCount: number): number {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0)
    throw new Error("Motion-vector vertex count must be a non-negative safe integer");
  const required = Math.max(MOTION_VECTOR_BYTES, vertexCount * MOTION_VECTOR_BYTES);
  return 2 ** Math.ceil(Math.log2(required));
}

function batchMap(batches: readonly GeometryBatch[]): Map<string, GeometryBatch> {
  return new Map(batches.map((batch) => [batchIdentity(batch), batch]));
}

function batchIdentity(
  batch: Pick<GeometryBatch, "instanceId" | "resourceInstanceId" | "selectionId">,
): string {
  return `${batch.selectionId}\u0000${batch.instanceId}\u0000${batch.resourceInstanceId}`;
}

function finiteDisplacement(value: number): number {
  return Number.isFinite(value) ? Math.max(-8, Math.min(8, value)) : 0;
}
