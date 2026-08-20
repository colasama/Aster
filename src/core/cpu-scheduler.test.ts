import { describe, expect, it } from "vitest";
import {
  CpuTaskScheduler,
  type CpuWorkerLike,
  MAX_CPU_QUEUE_CAPACITY,
  MAX_CPU_WORKERS,
} from "./cpu-scheduler";
import type { CpuTaskRequest, CpuTaskResponse, RadianceHdrCpuResult } from "./cpu-task-protocol";

class ControlledWorker implements CpuWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<CpuTaskResponse>) => void) | null = null;
  readonly requests: CpuTaskRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: CpuTaskRequest, transfer: Transferable[] = []): void {
    this.requests.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  succeed(result: string | Float32Array | RadianceHdrCpuResult): void {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("No worker request is pending");
    this.onmessage?.({
      data: { id: request.id, ok: true, result },
    } as MessageEvent<CpuTaskResponse>);
  }

  fail(code: string, message: string): void {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("No worker request is pending");
    this.onmessage?.({
      data: { error: { code, message, name: "TaskError" }, id: request.id, ok: false },
    } as MessageEvent<CpuTaskResponse>);
  }
}

describe("bounded CPU task scheduler", () => {
  it("runs real task implementations in deterministic inline fallback", async () => {
    const scheduler = new CpuTaskScheduler({ concurrency: 4, workerFactory: null });
    expect(scheduler.statistics()).toEqual({
      active: 0,
      backend: "inline",
      capacity: 64,
      concurrency: 1,
      queued: 0,
    });

    await expect(
      scheduler.submit({
        kind: "serialize-json",
        spacing: 2,
        trailingNewline: true,
        value: { frame: 42 },
      }),
    ).resolves.toBe('{\n  "frame": 42\n}\n');
    const peaks = await scheduler.submit({
      binCount: 2,
      kind: "waveform-peaks",
      samples: new Float32Array([-1, 0.5, -0.25, 1]),
    });
    expect(Array.from(peaks.slice(0, 2))).toEqual([-1, 0.5]);
    expect(peaks[2]).toBeCloseTo(Math.sqrt(0.625), 6);
    expect(Array.from(peaks.slice(3, 6))).toEqual([2, -0.25, 1]);
    expect(peaks[6]).toBeCloseTo(Math.sqrt(0.53125), 6);
    expect(peaks[7]).toBe(2);
    scheduler.dispose();
  });

  it("never runs worker-required HDR decoding on the main thread", async () => {
    const scheduler = new CpuTaskScheduler({ workerFactory: null });
    await expect(
      scheduler.submit(
        { kind: "decode-radiance-hdr", source: new ArrayBuffer(1) },
        { requireWorker: true },
      ),
    ).rejects.toMatchObject({ code: "worker-required" });
    scheduler.dispose();
  });

  it("transfers worker-only HDR input and accepts the final aligned payload", async () => {
    const worker = new ControlledWorker();
    const scheduler = new CpuTaskScheduler({ concurrency: 1, workerFactory: () => worker });
    const source = new ArrayBuffer(16);
    const decoded = scheduler.submit(
      { kind: "decode-radiance-hdr", source },
      { requireWorker: true, transfer: [source] },
    );
    await flushScheduler();
    expect(worker.transfers[0]).toEqual([source]);
    const pixels = new Uint16Array(128);
    worker.succeed({ width: 1, height: 1, bytesPerRow: 256, pixels });
    await expect(decoded).resolves.toEqual({ width: 1, height: 1, bytesPerRow: 256, pixels });
    scheduler.dispose();
  });

  it("orders queued work by priority and preserves FIFO within a priority", async () => {
    const workers: ControlledWorker[] = [];
    const scheduler = new CpuTaskScheduler({
      concurrency: 1,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = scheduler.submit({ kind: "serialize-json", value: "first" });
    await flushScheduler();
    const background = scheduler.submit(
      { kind: "serialize-json", value: "background" },
      { priority: "background" },
    );
    const interactiveA = scheduler.submit(
      { kind: "serialize-json", value: "interactive-a" },
      { priority: "interactive" },
    );
    const interactiveB = scheduler.submit(
      { kind: "serialize-json", value: "interactive-b" },
      { priority: "interactive" },
    );

    workers[0].succeed('"first"');
    await flushScheduler();
    expect(requestValue(workers[0])).toBe("interactive-a");
    workers[0].succeed('"interactive-a"');
    await flushScheduler();
    expect(requestValue(workers[0])).toBe("interactive-b");
    workers[0].succeed('"interactive-b"');
    await flushScheduler();
    expect(requestValue(workers[0])).toBe("background");
    workers[0].succeed('"background"');

    await expect(Promise.all([first, interactiveA, interactiveB, background])).resolves.toEqual([
      '"first"',
      '"interactive-a"',
      '"interactive-b"',
      '"background"',
    ]);
    scheduler.dispose();
  });

  it("cancels queued and active tasks and replaces a terminated worker", async () => {
    const workers: ControlledWorker[] = [];
    const scheduler = new CpuTaskScheduler({
      concurrency: 1,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    const activeAbort = new AbortController();
    const active = scheduler.submit(
      { kind: "serialize-json", value: "active" },
      { signal: activeAbort.signal },
    );
    await flushScheduler();
    const queuedAbort = new AbortController();
    const queued = scheduler.submit(
      { kind: "serialize-json", value: "queued" },
      { signal: queuedAbort.signal },
    );
    queuedAbort.abort();
    activeAbort.abort();

    await expect(queued).rejects.toMatchObject({ code: "cancelled", name: "AbortError" });
    await expect(active).rejects.toMatchObject({ code: "cancelled", name: "AbortError" });
    expect(workers[0].terminated).toBe(true);

    const recovered = scheduler.submit({ kind: "serialize-json", value: "recovered" });
    await flushScheduler();
    expect(workers).toHaveLength(2);
    workers[1].succeed('"recovered"');
    await expect(recovered).resolves.toBe('"recovered"');
    scheduler.dispose();
  });

  it("applies backpressure and enforces scheduler hard limits", async () => {
    const scheduler = new CpuTaskScheduler({ concurrency: 1, maxQueued: 1, workerFactory: null });
    const accepted = scheduler.submit({ kind: "serialize-json", value: "accepted" });
    await expect(
      scheduler.submit({ kind: "serialize-json", value: "overflow" }),
    ).rejects.toMatchObject({ code: "queue-full" });
    await expect(accepted).resolves.toBe('"accepted"');
    expect(() => new CpuTaskScheduler({ concurrency: MAX_CPU_WORKERS + 1 })).toThrow(RangeError);
    expect(() => new CpuTaskScheduler({ maxQueued: MAX_CPU_QUEUE_CAPACITY + 1 })).toThrow(
      RangeError,
    );
    scheduler.dispose();
  });

  it("terminates timed-out workers and falls back if worker creation is unavailable", async () => {
    const worker = new ControlledWorker();
    const scheduler = new CpuTaskScheduler({ concurrency: 1, workerFactory: () => worker });
    const timedOut = scheduler.submit({ kind: "serialize-json", value: "slow" }, { timeoutMs: 1 });
    await expect(timedOut).rejects.toMatchObject({ code: "timeout" });
    expect(worker.terminated).toBe(true);
    scheduler.dispose();

    const fallback = new CpuTaskScheduler({
      workerFactory: () => {
        throw new Error("Worker blocked by policy");
      },
    });
    await expect(fallback.submit({ kind: "serialize-json", value: "inline" })).resolves.toBe(
      '"inline"',
    );
    expect(fallback.statistics().backend).toBe("inline");
    fallback.dispose();
  });

  it("propagates structured task errors and survives failures", async () => {
    const worker = new ControlledWorker();
    const scheduler = new CpuTaskScheduler({ concurrency: 1, workerFactory: () => worker });
    const failed = scheduler.submit({ kind: "serialize-json", value: "failed" });
    await flushScheduler();
    worker.fail("invalid-task", "deterministic failure");
    await expect(failed).rejects.toMatchObject({
      code: "invalid-task",
      message: "deterministic failure",
      name: "TaskError",
    });
    const recovered = scheduler.submit({ kind: "serialize-json", value: "ok" });
    await flushScheduler();
    worker.succeed('"ok"');
    await expect(recovered).resolves.toBe('"ok"');
    scheduler.dispose();
  });
});

async function flushScheduler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function requestValue(worker: ControlledWorker): unknown {
  const request = worker.requests[worker.requests.length - 1];
  if (request?.task.kind !== "serialize-json") throw new Error("Expected JSON task");
  return request.task.value;
}
