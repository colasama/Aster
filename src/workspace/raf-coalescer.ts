export interface AnimationFrameHost {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export class RafCoalescer<Value> {
  private handle: number | undefined;
  private pending: Value | undefined;

  constructor(
    private readonly host: AnimationFrameHost,
    private readonly apply: (value: Value) => void,
  ) {}

  schedule(value: Value): void {
    this.pending = value;
    if (this.handle !== undefined) return;
    this.handle = this.host.request(() => {
      this.handle = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) this.apply(pending);
    });
  }

  flush(): void {
    if (this.handle !== undefined) this.host.cancel(this.handle);
    this.handle = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) this.apply(pending);
  }

  cancel(): void {
    if (this.handle !== undefined) this.host.cancel(this.handle);
    this.handle = undefined;
    this.pending = undefined;
  }
}

export function browserAnimationFrameHost(): AnimationFrameHost {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}
