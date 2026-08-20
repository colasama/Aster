export type RawFramePixelFormat = "bgra" | "rgba";

export interface RawVideoFrame {
  pixels: ArrayBuffer;
  pixelFormat: RawFramePixelFormat;
}

const BYTES_PER_PIXEL = 4;
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
}

export interface FrameReadbackTicket {
  encode(encoder: GPUCommandEncoder, source: GPUTexture): void;
  read(): Promise<RawVideoFrame>;
  abort(): void;
}

/**
 * Keeps a small, fixed set of readback buffers so export can overlap GPU rendering,
 * buffer mapping, and encoder input without accumulating frames for the whole job.
 */
export class GpuFrameReadbackPool {
  readonly #device: GPUDevice;
  readonly #pixelFormat: RawFramePixelFormat;
  readonly #slotCount: number;
  #slots: ReadbackSlot[] = [];
  #width = 0;
  #height = 0;
  #bytesPerRow = 0;

  constructor(device: GPUDevice, textureFormat: GPUTextureFormat, slotCount = 3) {
    if (!Number.isInteger(slotCount) || slotCount < 1)
      throw new Error("Frame readback slot count must be positive");
    this.#device = device;
    this.#pixelFormat = rawPixelFormat(textureFormat);
    this.#slotCount = slotCount;
  }

  get pixelFormat(): RawFramePixelFormat {
    return this.#pixelFormat;
  }

  reserve(width: number, height: number): FrameReadbackTicket {
    this.#ensureBuffers(width, height);
    const slot = this.#slots.find((candidate) => !candidate.busy);
    if (!slot) throw new Error("All GPU frame readback buffers are busy");
    slot.busy = true;
    let encoded = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.busy = false;
    };
    return {
      encode: (encoder, source) => {
        if (released || encoded) throw new Error("Frame readback ticket is no longer writable");
        encoder.copyTextureToBuffer(
          { texture: source },
          { buffer: slot.buffer, bytesPerRow: this.#bytesPerRow, rowsPerImage: height },
          [width, height],
        );
        encoded = true;
      },
      read: async () => {
        if (!encoded) {
          release();
          throw new Error("Frame readback was not encoded before mapping");
        }
        try {
          await slot.buffer.mapAsync(GPUMapMode.READ);
          const mapped = new Uint8Array(slot.buffer.getMappedRange());
          const pixels = compactReadbackRows(mapped, width, height, this.#bytesPerRow);
          return { pixels, pixelFormat: this.#pixelFormat };
        } finally {
          if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
          release();
        }
      },
      abort: () => {
        if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
        release();
      },
    };
  }

  destroy(): void {
    if (this.#slots.some((slot) => slot.busy))
      throw new Error("Cannot destroy GPU frame readback buffers while frames are in flight");
    this.reset();
  }

  reset(): boolean {
    if (this.#slots.some((slot) => slot.busy)) return false;
    for (const slot of this.#slots) slot.buffer.destroy();
    this.#slots = [];
    this.#width = 0;
    this.#height = 0;
    this.#bytesPerRow = 0;
    return true;
  }

  #ensureBuffers(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new Error("Frame readback dimensions must be positive integers");
    if (width === this.#width && height === this.#height && this.#slots.length > 0) return;
    if (this.#slots.some((slot) => slot.busy))
      throw new Error("Cannot resize GPU frame readback buffers while frames are in flight");
    for (const slot of this.#slots) slot.buffer.destroy();
    this.#width = width;
    this.#height = height;
    this.#bytesPerRow = alignedReadbackBytesPerRow(width);
    const size = this.#bytesPerRow * height;
    this.#slots = Array.from({ length: this.#slotCount }, (_, index) => ({
      buffer: this.#device.createBuffer({
        label: `Video export readback ${index + 1}/${this.#slotCount}`,
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      busy: false,
    }));
  }
}

export function alignedReadbackBytesPerRow(width: number): number {
  if (!Number.isInteger(width) || width < 1)
    throw new Error("Frame readback width must be a positive integer");
  const rowBytes = width * BYTES_PER_PIXEL;
  return Math.ceil(rowBytes / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
}

export function compactReadbackRows(
  source: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
): ArrayBuffer {
  const tightRowBytes = width * BYTES_PER_PIXEL;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    bytesPerRow < tightRowBytes ||
    source.byteLength < bytesPerRow * height
  )
    throw new Error("Invalid GPU frame readback layout");
  if (bytesPerRow === tightRowBytes) return source.slice(0, tightRowBytes * height).buffer;
  const output = new Uint8Array(tightRowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * bytesPerRow;
    output.set(source.subarray(sourceOffset, sourceOffset + tightRowBytes), row * tightRowBytes);
  }
  return output.buffer;
}

export function rawPixelFormat(textureFormat: GPUTextureFormat): RawFramePixelFormat {
  if (textureFormat === "bgra8unorm" || textureFormat === "bgra8unorm-srgb") return "bgra";
  if (textureFormat === "rgba8unorm" || textureFormat === "rgba8unorm-srgb") return "rgba";
  throw new Error(
    `Canvas texture format ${textureFormat} cannot be exported as packed 8-bit video`,
  );
}
