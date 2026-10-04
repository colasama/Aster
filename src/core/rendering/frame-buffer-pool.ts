export interface FrameBufferLease {
  readonly buffer: ArrayBuffer;
  /** Return only after all asynchronous consumers have acknowledged the frame. */
  release(): void;
}

interface FrameBufferSlot {
  buffer: ArrayBuffer;
  busy: boolean;
}

/** Bounded owned CPU destinations; GPU mappings are never retained or shared here. */
export class FrameBufferPool {
  readonly #slots: FrameBufferSlot[] = [];

  constructor(
    private readonly byteLength: number,
    private readonly capacity: number,
  ) {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(byteLength * capacity)
    )
      throw new Error("Frame buffer pool requires positive bounded byte length and capacity");
  }

  acquire(): FrameBufferLease {
    let slot = this.#slots.find((candidate) => !candidate.busy);
    if (!slot) {
      if (this.#slots.length === this.capacity)
        throw new Error("All owned frame buffers are leased");
      slot = { buffer: new ArrayBuffer(this.byteLength), busy: false };
      this.#slots.push(slot);
    }
    const owned = slot;
    const validate = () => {
      if (owned.buffer.byteLength !== this.byteLength)
        throw new Error("Owned frame buffer was detached or changed size");
    };
    validate();
    owned.busy = true;
    let released = false;
    return {
      get buffer() {
        if (released) throw new Error("Frame buffer lease was already released");
        validate();
        return owned.buffer;
      },
      release() {
        if (released) return;
        released = true;
        owned.busy = false;
        validate();
      },
    };
  }
}
