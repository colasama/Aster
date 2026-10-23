import { expect, test } from "vitest";
import { NativeQueueReporter } from "./native-queue-reporter.js";
import type { RenderHostReport } from "./render-queue-manager.js";

test("slow persistence retains one latest progress value and invalidates stale pauses", async () => {
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const events: RenderHostReport[] = [],
    errors: unknown[] = [];
  const reporter = new NativeQueueReporter(
    "job",
    "lease",
    async (event) => {
      events.push(event);
      if (events.length === 1) {
        started();
        await blocked;
      }
    },
    (error) => errors.push(error),
  );
  reporter.progress({ completedFrames: 0, totalFrames: 1000, elapsedMs: 0 });
  await began;
  for (let frame = 1; frame <= 1000; frame++)
    reporter.progress({ completedFrames: frame, totalFrames: 1000, elapsedMs: frame });
  reporter.paused(() => true);
  reporter.clearPause();
  release();
  await reporter.flush();
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ progress: { completedFrames: 1000 } });
  expect(errors).toEqual([]);
});

test("report failures settle the lane and stop further progress", async () => {
  const failures: unknown[] = [];
  const reporter = new NativeQueueReporter(
    "job",
    "lease",
    async () => {
      throw new Error("storage unavailable");
    },
    (error) => failures.push(error),
  );
  reporter.progress({ completedFrames: 1, totalFrames: 2, elapsedMs: 1 });
  await reporter.flush();
  reporter.progress({ completedFrames: 2, totalFrames: 2, elapsedMs: 2 });
  await reporter.flush();
  expect(failures).toHaveLength(1);
});
