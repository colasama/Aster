import { describe, expect, it, vi } from "vitest";
import type { RendererMetrics } from "../../src/core/types";
import { caseFor, fixture } from "../parity/generators/base";
import { performanceRenderAssignment } from "./assignment";
import { measurePreviewPerformance } from "./preview-runner";
import type { PerformanceAssignment } from "./protocol";
import type { PerformanceSession } from "./runtime";

function scenario() {
  const { project, composition } = fixture("preview-test");
  composition.frameRate = { numerator: 24000, denominator: 1001 };
  const generated = caseFor("preview-test", project, [], { frames: [3, 6] });
  const assignment: PerformanceAssignment = {
    case: generated.case,
    frames: [3, 6],
    projectPath: "preview/project.json",
    caseHash: "c".repeat(64),
    benchmark: {
      id: "preview-test-1",
      mode: "preview-present",
      run: 1,
      warmupFrames: 10,
      startFrame: 3,
      endFrameExclusive: 7,
      frameRate: composition.frameRate,
    },
  };
  const metrics: RendererMetrics = {
    fps: 0,
    frameMs: 0,
    cpuMs: 0,
    gpuMs: 999,
    drawCalls: 2,
    passCount: 3,
    dirtyNodes: 0,
    cacheHitRate: 0,
    estimatedVramMb: 0,
    transientTextureCount: 0,
  };
  let clock = 0;
  let pending = false;
  const present = vi.fn((_time: number) => {
    expect(pending).toBe(false);
    pending = true;
    clock += 2;
    return metrics;
  });
  const complete = vi.fn(async () => {
    await Promise.resolve();
    expect(pending).toBe(true);
    clock += 5;
    pending = false;
  });
  const session: PerformanceSession = {
    validated: performanceRenderAssignment(assignment, generated.project),
    pixelFormat: "bgra",
    maxConcurrentReadbacks: 3,
    loadMs: 2,
    initializeMs: 3,
    readback: vi.fn(async () => {
      throw new Error("Preview readback is forbidden");
    }),
    present,
    complete,
    assertHealthy: vi.fn(),
    dispose: vi.fn(async () => {}),
    diagnostics: () => ({
      available: true,
      adapter: "test",
      architecture: "test",
      description: "test",
      maxTextureSize: 8192,
      timestampQueries: false,
    }),
  };
  return { assignment, session, metrics, present, complete, now: () => clock };
}

describe("production preview measurements", () => {
  it("serially awaits GPU completion at rational addresses and excludes every warm-up sample", async () => {
    const data = scenario();
    const result = await measurePreviewPerformance(data.assignment, data.session, data.now);
    const warmup = Array.from({ length: 10 }, (_, index) => 3 + (index % 4));
    expect(data.present.mock.calls.map(([time]) => time)).toEqual(
      [...warmup, 3, 4, 5, 6].map((frame) => (frame * 1001) / 24000),
    );
    expect(data.complete).toHaveBeenCalledTimes(14);
    expect(data.session.readback).not.toHaveBeenCalled();
    expect(result.samples).toEqual(
      [3, 4, 5, 6].map((frame) => ({ frame, presentCallMs: 2, presentCompletionMs: 7 })),
    );
    expect(result.elapsedMs).toBe(28);
    expect(result.framesPerSecond).toBe(4000 / 28);
    expect(result.maxInFlight).toBe(1);
    expect(result).not.toHaveProperty("gpuMs");
    expect(result).not.toHaveProperty("readbackWallLatenciesMs");
  });

  it("never submits the next frame until the queue completion promise resolves", async () => {
    const data = scenario();
    let unblock: (() => void) | undefined;
    data.session.complete = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      await data.complete();
    });
    // The runner captures the method for the session, so release every queued completion.
    const measured = measurePreviewPerformance(data.assignment, data.session, data.now);
    for (let index = 0; index < 14; index++) {
      await vi.waitFor(() => expect(data.present).toHaveBeenCalledTimes(index + 1));
      expect(unblock).toBeDefined();
      unblock?.();
    }
    await measured;
  });

  it("rejects missing, incomplete or failed production frames and invalid clocks", async () => {
    for (const problem of ["missing", "pending", "empty", "queue", "health", "clock"]) {
      const data = scenario();
      if (problem === "missing") delete data.session.present;
      if (problem === "pending") data.metrics.mediaPending = true;
      if (problem === "empty") data.metrics.drawCalls = 0;
      if (problem === "queue")
        data.session.complete = async () => {
          throw new Error("queue failed");
        };
      if (problem === "health")
        data.session.assertHealthy = () => {
          throw new Error("GPU failed");
        };
      await expect(
        measurePreviewPerformance(
          data.assignment,
          data.session,
          problem === "clock" ? () => Number.NaN : data.now,
        ),
      ).rejects.toThrow();
    }
  });
});
