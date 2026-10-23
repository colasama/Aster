import type { RenderJobProgress } from "../src/core/rendering/render-queue.js";
import type { RenderHostReport } from "./render-queue-manager.js";

/** One report in flight and one latest progress value, independent of renderer throughput. */
export class NativeQueueReporter {
  #progress?: RenderJobProgress;
  #pause?: () => boolean;
  #pending?: Promise<void>;
  #failed = false;
  constructor(
    readonly jobId: string,
    readonly leaseId: string,
    readonly emit: (event: RenderHostReport) => Promise<void>,
    readonly fail: (error: unknown) => void,
  ) {}

  progress(value: RenderJobProgress): void {
    if (this.#failed) return;
    this.#progress = value;
    this.#pump();
  }

  paused(current: () => boolean): void {
    if (this.#failed) return;
    this.#pause = current;
    this.#pump();
  }

  clearPause(): void {
    this.#pause = undefined;
  }

  async flush(): Promise<void> {
    while (this.#pending) await this.#pending;
  }

  #pump(): void {
    if (this.#pending || this.#failed) return;
    this.#pending = Promise.resolve()
      .then(async () => {
        while (this.#progress || this.#pause) {
          const progress = this.#progress;
          if (progress) {
            this.#progress = undefined;
            await this.emit({
              type: "progress",
              jobId: this.jobId,
              leaseId: this.leaseId,
              progress,
            });
          } else {
            const current = this.#pause;
            this.#pause = undefined;
            if (current?.())
              await this.emit({ type: "paused", jobId: this.jobId, leaseId: this.leaseId });
          }
        }
      })
      .catch((error) => {
        this.#failed = true;
        this.#progress = undefined;
        this.#pause = undefined;
        this.fail(error);
      })
      .finally(() => {
        this.#pending = undefined;
        if (this.#progress || this.#pause) this.#pump();
      });
  }
}
