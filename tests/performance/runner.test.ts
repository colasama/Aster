import { describe, expect, it, vi } from "vitest";
import { alignedAudioFrameCount } from "../../src/core/audio/audio-export";
import { CaptureHealth } from "../parity/capture-health";
import { caseFor, fixture } from "../parity/generators/base";
import { attachAudioFixture } from "../parity/generators/media";
import { performanceRenderAssignment, validatePerformanceAssignment } from "./assignment";
import { PerformanceOutput } from "./output";
import type { PerformanceApi, PerformanceAssignment, PerformanceMode } from "./protocol";
import { measurePerformance, runPerformanceAssignments } from "./runner";
import type { PerformanceSession } from "./runtime";

function scenario(mode: PerformanceMode = "readback-only", audio = false) {
  const { project, composition, layer } = fixture("performance-test");
  composition.width = 2;
  composition.height = 1;
  composition.frameRate = { numerator: 24000, denominator: 1001 };
  if (audio) {
    const source = attachAudioFixture(project);
    const audible = layer("audio");
    audible.sourceId = source.id;
    composition.layers.push(audible);
  }
  const generated = caseFor("performance-test", project, [], { frames: [3, 6] });
  const assignment: PerformanceAssignment = {
    case: generated.case,
    frames: generated.case.frames,
    projectPath: "D:/fixtures/performance-test/project.json",
    caseHash: "b".repeat(64),
    benchmark: {
      id: "performance-test-readback-1",
      mode,
      run: 1,
      warmupFrames: 10,
      startFrame: 3,
      endFrameExclusive: 7,
      frameRate: composition.frameRate,
    },
  };
  const validated = performanceRenderAssignment(assignment, generated.project);
  const readback = vi.fn(async () => ({
    pixels: new ArrayBuffer(8),
    pixelFormat: "bgra" as const,
  }));
  const session: PerformanceSession = {
    validated,
    pixelFormat: "bgra",
    maxConcurrentReadbacks: 3,
    loadMs: 2,
    initializeMs: 3,
    readback,
    diagnostics: () => ({
      available: true,
      adapter: "test",
      architecture: "test",
      description: "test",
      maxTextureSize: 8192,
      timestampQueries: false,
    }),
    assertHealthy: vi.fn(),
    dispose: vi.fn(async () => undefined),
    ...(audio || mode === "full-mp4"
      ? {
          audioDecoder: vi.fn(async () => ({
            sampleRate: 48000,
            channels: [new Float32Array(48000).fill(0.2), new Float32Array(48000).fill(0.2)],
          })),
        }
      : {}),
  };
  let time = 0;
  const now = () => ++time;
  const output = vi.fn(async (_request: Parameters<PerformanceApi["output"]>[0]) => undefined);
  return { assignment, project: generated.project, session, now, output };
}

describe("production performance frame loop", () => {
  it("uses the production destination capability while retaining complete ordered output", async () => {
    const data = scenario("ipc-no-encode");
    data.session.maxConcurrentReadbacks = 1;
    let frame = 3;
    const destinations: ArrayBuffer[] = [];
    data.session.readbackInto = vi.fn(async (_time: number, destination: ArrayBuffer) => {
      destinations.push(destination);
      new Uint8Array(destination).fill(frame++);
      return { pixels: destination, pixelFormat: "bgra" as const };
    });
    const received: number[] = [];
    const result = await measurePerformance(
      data.assignment,
      data.session,
      async (request) => {
        if (request.type === "writeMp4Frame") received.push(new Uint8Array(request.pixels)[0]);
      },
      data.now,
    );
    expect(data.session.readback).toHaveBeenCalledTimes(10);
    expect(data.session.readbackInto).toHaveBeenCalledTimes(4);
    expect(new Set(destinations).size).toBe(2);
    expect(received).toEqual([3, 4, 5, 6]);
    expect(result.frameCompletionIntervalsMs).toHaveLength(4);
    expect(result.maxInFlight).toBe(1);
  });

  it("rejects a session that silently ignores its supplied destination", async () => {
    const data = scenario();
    data.session.readbackInto = async () => ({ pixels: new ArrayBuffer(8), pixelFormat: "bgra" });
    await expect(
      measurePerformance(data.assignment, data.session, data.output, data.now),
    ).rejects.toThrow(/destination/);
  });

  it("keeps rational addresses, excludes warm-up, and never invokes IPC in the local arm", async () => {
    const data = scenario();
    const result = await measurePerformance(data.assignment, data.session, data.output, data.now);
    const addresses = vi.mocked(data.session.readback).mock.calls.map(([time]) => time);
    expect(addresses.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => ((3 + (index % 4)) * 1001) / 24000),
    );
    expect(addresses.slice(10)).toEqual([3, 4, 5, 6].map((frame) => (frame * 1001) / 24000));
    expect(result.frameCompletionIntervalsMs).toHaveLength(4);
    expect(result.readbackWallLatenciesMs).toHaveLength(4);
    expect(result.outputInvokeLatenciesMs).toEqual([]);
    expect(result.maxInFlight).toBe(3);
    expect(result.audio).toBeNull();
    expect(result).not.toHaveProperty("gpuMs");
    expect(data.output).not.toHaveBeenCalled();
  });

  it("awaits every real IPC acknowledgment and includes encoder finish in elapsed time", async () => {
    const data = scenario("ipc-no-encode");
    let time = 0;
    const output = vi.fn(async (request: Parameters<PerformanceApi["output"]>[0]) => {
      time += request.type === "startMp4" ? 5000 : request.type === "finishMp4" ? 70 : 5;
    });
    const result = await measurePerformance(data.assignment, data.session, output, () => ++time);
    expect(output.mock.calls.map(([value]) => value.type)).toEqual([
      "startMp4",
      "writeMp4Frame",
      "writeMp4Frame",
      "writeMp4Frame",
      "writeMp4Frame",
      "finishMp4",
    ]);
    expect(result.elapsedMs).toBeGreaterThan(90);
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.outputInvokeLatenciesMs).toHaveLength(6);
    expect(result.outputInvokeLatenciesMs[0].elapsedMs).toBeGreaterThan(5000);
  });

  it("retains video synchronization and its serial readback limit", async () => {
    const data = scenario();
    data.session.validated.synchronizeVideo = true;
    let pending = 0;
    let maximum = 0;
    data.session.readback = async () => {
      pending++;
      maximum = Math.max(maximum, pending);
      await Promise.resolve();
      pending--;
      return { pixels: new ArrayBuffer(8), pixelFormat: "bgra" };
    };
    const result = await measurePerformance(data.assignment, data.session, data.output, data.now);
    expect(maximum).toBe(1);
    expect(result.maxInFlight).toBe(1);
    expect(result.synchronizeVideo).toBe(true);
  });

  it("streams actual production mixed audio only in the full MP4 arm", async () => {
    const data = scenario("full-mp4", true);
    data.assignment.benchmark.requireAudio = true;
    const result = await measurePerformance(data.assignment, data.session, data.output, data.now);
    const frames = alignedAudioFrameCount(4, data.assignment.benchmark.frameRate);
    expect(result.audio).toEqual({
      enabled: true,
      frameCount: frames,
      sampleRate: 48000,
      channels: 2,
    });
    const chunks = data.output.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "writeMp4Audio");
    expect(chunks.reduce((total, request) => total + request.samples.byteLength / 8, 0)).toBe(
      frames,
    );
    expect(
      chunks.some((request) => new Float32Array(request.samples).some((value) => value !== 0)),
    ).toBe(true);
    expect(data.session.audioDecoder).toHaveBeenCalledOnce();
    const local = scenario("readback-only", true);
    const localResult = await measurePerformance(
      local.assignment,
      local.session,
      local.output,
      local.now,
    );
    expect(localResult.audio).toBeNull();
    expect(local.session.audioDecoder).not.toHaveBeenCalled();
    const silent = scenario("full-mp4");
    silent.assignment.benchmark.requireAudio = true;
    await expect(
      measurePerformance(silent.assignment, silent.session, silent.output, silent.now),
    ).rejects.toThrow("requires an audible");
  });

  it("rejects truncated readbacks and failed output instead of publishing timing", async () => {
    const truncated = scenario();
    truncated.session.readback = async () => ({ pixels: new ArrayBuffer(4), pixelFormat: "bgra" });
    await expect(
      measurePerformance(truncated.assignment, truncated.session, truncated.output, truncated.now),
    ).rejects.toThrow("malformed frame");
    const failed = scenario("ipc-no-encode");
    await expect(
      measurePerformance(
        failed.assignment,
        failed.session,
        async () => {
          throw new Error("IPC lost");
        },
        failed.now,
      ),
    ).rejects.toThrow("IPC lost");
  });

  it("disposes and rejects cleanup failures before completing or taking another workload", async () => {
    const data = scenario();
    data.session.dispose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const api: PerformanceApi = {
      ready: vi.fn(async () => undefined),
      take: vi.fn(async () => data.assignment),
      output: data.output,
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      done: vi.fn(async () => undefined),
    };
    await expect(
      runPerformanceAssignments(api, { open: async () => data.session }, new CaptureHealth()),
    ).rejects.toThrow("cleanup failed");
    expect(api.take).toHaveBeenCalledOnce();
    expect(api.complete).not.toHaveBeenCalled();
    expect(data.session.dispose).toHaveBeenCalledOnce();
  });
});

describe("performance input and stream guards", () => {
  it("accepts explicit warm-up run zero but rejects invalid ranges and project rate drift", () => {
    const data = scenario();
    data.assignment.benchmark.run = 0;
    expect(() => validatePerformanceAssignment(data.assignment)).not.toThrow();
    data.assignment.benchmark.frameRate = { numerator: 30, denominator: 1 };
    expect(() => performanceRenderAssignment(data.assignment, data.project)).toThrow(
      "differs from the project",
    );
    data.assignment.benchmark.endFrameExclusive = 3;
    expect(() => validatePerformanceAssignment(data.assignment)).toThrow("frame range");
  });

  it("rejects partial output completion, duplicate start, wrong correlation, and audio in the local arm", () => {
    const data = scenario();
    const correlation = {
      jobId: data.assignment.benchmark.id,
      leaseId: "benchmark-1",
      outputId: "mp4",
    };
    const tracker = new PerformanceOutput(data.assignment, "bgra");
    expect(() => tracker.accept({ type: "finishMp4", ...correlation })).toThrow("not started");
    const start = {
      type: "startMp4" as const,
      ...correlation,
      pixelFormat: "bgra" as const,
      videoBitrateBps: 20_000_000,
    };
    expect(() => tracker.accept({ ...start, jobId: "different" })).toThrow("correlation");
    expect(() =>
      tracker.accept({ ...start, audio: { frameCount: 1, sampleRate: 48000, channels: 2 } }),
    ).toThrow("Only MP4");
    tracker.accept(start);
    expect(() => tracker.accept(start)).toThrow("twice");
    expect(() => tracker.accept({ type: "finishMp4", ...correlation })).toThrow("incomplete");
  });
});
