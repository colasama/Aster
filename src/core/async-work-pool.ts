interface PendingWork<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class AsyncWorkPool {
  readonly #concurrency: number;
  readonly #queue: PendingWork<unknown>[] = [];
  #active = 0;

  constructor(concurrency: number) {
    this.#concurrency = Math.max(1, Math.floor(concurrency));
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ task, resolve, reject } as PendingWork<unknown>);
      this.#drain();
    });
  }

  statistics(): { active: number; queued: number; concurrency: number } {
    return { active: this.#active, queued: this.#queue.length, concurrency: this.#concurrency };
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const pending = this.#queue.shift();
      if (!pending) return;
      this.#active += 1;
      void pending
        .task()
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }
}
