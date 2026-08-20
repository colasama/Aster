const COPY_ROW_ALIGNMENT = 256;
const DEFAULT_MAX_STAGING_BYTES = 64 * 1024 * 1024;

interface PendingTextureUpload {
  texture: GPUTexture;
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface PlannedTextureUpload {
  offset: number;
  bytesPerRow: number;
  byteLength: number;
}

export interface TextureUploadStatistics {
  batched: number;
  fallback: number;
  bytes: number;
}

export class TextureUploadBatch {
  readonly #device: GPUDevice;
  readonly #maxStagingBytes: number;
  readonly #pending: PendingTextureUpload[] = [];
  #staging?: GPUBuffer;
  #stagingCapacity = 0;

  constructor(device: GPUDevice, maxStagingBytes = DEFAULT_MAX_STAGING_BYTES) {
    this.#device = device;
    this.#maxStagingBytes = Math.max(
      COPY_ROW_ALIGNMENT,
      Math.min(maxStagingBytes, Number(device.limits.maxBufferSize)),
    );
  }

  get capacityBytes() {
    return this.#stagingCapacity;
  }

  enqueue(texture: GPUTexture, pixels: ArrayBufferView, width: number, height: number): void {
    const boundedWidth = Math.max(1, Math.floor(width));
    const boundedHeight = Math.max(1, Math.floor(height));
    const requiredBytes = boundedWidth * boundedHeight * 4;
    if (pixels.byteLength < requiredBytes) throw new Error("RGBA texture upload is truncated");
    this.#pending.push({
      texture,
      pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, requiredBytes),
      width: boundedWidth,
      height: boundedHeight,
    });
  }

  flush(encoder: GPUCommandEncoder): TextureUploadStatistics {
    const statistics = { batched: 0, fallback: 0, bytes: 0 };
    if (this.#pending.length === 0) return statistics;
    const plans: PlannedTextureUpload[] = [];
    const batched: PendingTextureUpload[] = [];
    let offset = 0;
    for (const upload of this.#pending.splice(0)) {
      const plan = planTextureUpload(upload.width, upload.height, offset);
      if (plan.offset + plan.byteLength > this.#maxStagingBytes) {
        this.#device.queue.writeTexture(
          { texture: upload.texture },
          upload.pixels,
          { bytesPerRow: upload.width * 4, rowsPerImage: upload.height },
          [upload.width, upload.height],
        );
        statistics.fallback += 1;
      } else {
        plans.push(plan);
        batched.push(upload);
        offset = plan.offset + plan.byteLength;
      }
      statistics.bytes += upload.width * upload.height * 4;
    }
    if (batched.length === 0) return statistics;
    this.#ensureStagingCapacity(offset);
    const packed = new Uint8Array(offset);
    for (let index = 0; index < batched.length; index += 1) {
      const upload = batched[index];
      const plan = plans[index];
      packTextureUploadRows(packed, plan, upload.pixels, upload.width, upload.height);
      encoder.copyBufferToTexture(
        {
          buffer: this.#staging as GPUBuffer,
          offset: plan.offset,
          bytesPerRow: plan.bytesPerRow,
          rowsPerImage: upload.height,
        },
        { texture: upload.texture },
        [upload.width, upload.height],
      );
    }
    this.#device.queue.writeBuffer(this.#staging as GPUBuffer, 0, packed);
    statistics.batched = batched.length;
    return statistics;
  }

  #ensureStagingCapacity(requiredBytes: number): void {
    if (requiredBytes <= this.#stagingCapacity) return;
    this.#stagingCapacity = Math.min(
      this.#maxStagingBytes,
      2 ** Math.ceil(Math.log2(Math.max(COPY_ROW_ALIGNMENT, requiredBytes))),
    );
    this.#staging?.destroy();
    this.#staging = this.#device.createBuffer({
      label: `Persistent texture upload staging · ${Math.round(this.#stagingCapacity / 1024)} KiB`,
      size: this.#stagingCapacity,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }
}

export function planTextureUpload(
  width: number,
  height: number,
  previousEnd = 0,
): PlannedTextureUpload {
  const bytesPerRow = align(Math.max(1, Math.floor(width)) * 4, COPY_ROW_ALIGNMENT);
  const offset = align(Math.max(0, Math.floor(previousEnd)), COPY_ROW_ALIGNMENT);
  return {
    offset,
    bytesPerRow,
    byteLength: bytesPerRow * Math.max(1, Math.floor(height)),
  };
}

export function packTextureUploadRows(
  destination: Uint8Array,
  plan: PlannedTextureUpload,
  source: Uint8Array,
  width: number,
  height: number,
): void {
  const sourceRowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceRowBytes;
    destination.set(
      source.subarray(sourceOffset, sourceOffset + sourceRowBytes),
      plan.offset + row * plan.bytesPerRow,
    );
  }
}

function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}
