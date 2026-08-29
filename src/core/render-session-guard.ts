export interface RenderSessionLease {
  close(): void;
}

/** Allows exactly one renderer-resizing session and releases even when restoration throws. */
export class ExclusiveRenderSessionGuard {
  #active = false;

  get active(): boolean {
    return this.#active;
  }

  acquire(restore: () => void): RenderSessionLease {
    if (this.#active) throw new Error("A production render session is already active");
    this.#active = true;
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        try {
          restore();
        } finally {
          this.#active = false;
        }
      },
    };
  }
}

/** Bounds work within one lease and defers restoration until every accepted frame settles. */
export class BoundedRenderSessionController {
  readonly #lease: RenderSessionLease;
  readonly #maximumInFlight: number;
  #closed = false;
  #inFlight = 0;

  constructor(lease: RenderSessionLease, maximumInFlight: number) {
    if (!Number.isSafeInteger(maximumInFlight) || maximumInFlight < 1)
      throw new Error("Render session concurrency must be a positive safe integer");
    this.#lease = lease;
    this.#maximumInFlight = maximumInFlight;
  }

  async run<Output>(work: () => Promise<Output>): Promise<Output> {
    if (this.#closed) throw new Error("Render session is already closed");
    if (this.#inFlight >= this.#maximumInFlight)
      throw new Error("Render session exceeded its bounded in-flight frame count");
    this.#inFlight += 1;
    try {
      return await work();
    } finally {
      this.#inFlight -= 1;
      if (this.#closed && this.#inFlight === 0) this.#lease.close();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#inFlight === 0) this.#lease.close();
  }
}
