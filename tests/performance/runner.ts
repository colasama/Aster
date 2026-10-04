import { runRenderHostFrameLoop } from "../../src/components/render-host/render-host-session";
import { frameTimeAtIndex } from "../../src/core/rendering/render-export";
import { CaptureHealth, captureErrorMessage } from "../parity/capture-health";
import { validatePerformanceAssignment } from "./assignment";
import { PerformanceOutput } from "./output";
import { measurePreviewPerformance } from "./preview-runner";
import type {
  PerformanceApi,
  PerformanceAssignment,
  PerformanceResult,
  PreviewPerformanceResult,
} from "./protocol";
import type { PerformanceRuntime, PerformanceSession } from "./runtime";

export async function measurePerformance(
  assignment: PerformanceAssignment,
  session: PerformanceSession,
  output: PerformanceApi["output"],
  now: () => number = () => performance.now(),
): Promise<PerformanceResult> {
  validatePerformanceAssignment(assignment);
  const { benchmark } = assignment;
  if (benchmark.mode === "preview-present") throw new Error("Preview must use the present runner");
  const { validated } = session;
  const { manifest } = validated;
  const frames = benchmark.endFrameExclusive - benchmark.startFrame;
  const validateRaw = (raw: Awaited<ReturnType<PerformanceSession["readback"]>>) => {
    if (
      raw.pixelFormat !== session.pixelFormat ||
      raw.pixels.byteLength !== manifest.width * manifest.height * 4
    )
      throw new Error("Benchmark readback returned a malformed frame");
    session.assertHealthy();
    return raw;
  };
  for (let index = 0; index < benchmark.warmupFrames; index++) {
    session.assertHealthy();
    validateRaw(
      await session.readback(
        frameTimeAtIndex(benchmark.startFrame + (index % frames), manifest.frameRate),
      ),
    );
  }
  const frameCompletionIntervalsMs: number[] = [];
  const readbackWallLatenciesMs = new Array<number>(frames);
  const outputInvokeLatenciesMs: PerformanceResult["outputInvokeLatenciesMs"] = [];
  const tracker = new PerformanceOutput(assignment, session.pixelFormat);
  let preparedAt: number | undefined;
  let lastProgressAt: number | undefined;
  let completedAt: number | undefined;
  const renderFrame = async (frame: number, time: number, destination?: ArrayBuffer) => {
    session.assertHealthy();
    const started = now();
    const raw =
      destination === undefined
        ? await session.readback(time)
        : await session.readbackInto?.(time, destination);
    if (!raw) throw new Error("Benchmark session does not support readback destinations");
    readbackWallLatenciesMs[frame - benchmark.startFrame] = now() - started;
    return validateRaw(raw);
  };
  const result = await runRenderHostFrameLoop({
    assignment: validated,
    pixelFormat: session.pixelFormat,
    maxInFlightFrames: session.maxConcurrentReadbacks,
    audioDecoder: session.audioDecoder,
    requestedControl: () => undefined,
    now,
    renderFrame,
    ...(session.readbackInto ? { renderFrameInto: renderFrame } : {}),
    encodePng: async () => {
      throw new Error("Performance MP4 loop unexpectedly requested PNG encoding");
    },
    output: async (request) => {
      session.assertHealthy();
      tracker.accept(request);
      if (benchmark.mode === "readback-only") return;
      const started = now();
      const response = await output(request);
      outputInvokeLatenciesMs.push({ type: request.type, elapsedMs: now() - started });
      session.assertHealthy();
      return response;
    },
    report: async (report) => {
      const time = now();
      if (report.type === "prepared") {
        if (preparedAt !== undefined) throw new Error("Benchmark was prepared twice");
        preparedAt = lastProgressAt = time;
      } else if (report.type === "progress") {
        if (
          lastProgressAt === undefined ||
          report.progress.completedFrames !== frameCompletionIntervalsMs.length + 1 ||
          report.progress.totalFrames !== frames
        )
          throw new Error("Benchmark progress is missing, duplicated, or out of order");
        frameCompletionIntervalsMs.push(time - lastProgressAt);
        lastProgressAt = time;
      } else if (report.type === "completed") completedAt = time;
      else throw new Error(`Unexpected benchmark terminal state: ${report.type}`);
    },
  });
  session.assertHealthy();
  tracker.assertComplete();
  if (result !== "completed" || preparedAt === undefined || completedAt === undefined)
    throw new Error("Benchmark did not complete its measured interval");
  const elapsedMs = completedAt - preparedAt;
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    frameCompletionIntervalsMs.length !== frames ||
    Array.from(readbackWallLatenciesMs).some((time) => !Number.isFinite(time) || time < 0) ||
    frameCompletionIntervalsMs.some((time) => !Number.isFinite(time) || time < 0) ||
    outputInvokeLatenciesMs.some(({ elapsedMs }) => !Number.isFinite(elapsedMs) || elapsedMs < 0)
  )
    throw new Error("Benchmark timing samples are incomplete or invalid");
  return {
    schemaVersion: 1,
    id: benchmark.id,
    benchmarkId: benchmark.id,
    caseId: assignment.case.id,
    mode: benchmark.mode,
    run: benchmark.run,
    frames,
    warmupFrames: benchmark.warmupFrames,
    startFrame: benchmark.startFrame,
    endFrameExclusive: benchmark.endFrameExclusive,
    width: manifest.width,
    height: manifest.height,
    frameRate: { ...manifest.frameRate },
    pixelFormat: session.pixelFormat,
    synchronizeVideo: validated.synchronizeVideo,
    maxInFlight: validated.synchronizeVideo
      ? 1
      : Math.min(
          session.maxConcurrentReadbacks,
          3,
          Math.max(1, Math.floor((64 * 1024 * 1024) / (manifest.width * manifest.height * 4))),
        ),
    elapsedMs,
    framesPerSecond: (frames * 1000) / elapsedMs,
    frameCompletionIntervalsMs,
    readbackWallLatenciesMs,
    outputInvokeLatenciesMs,
    audio: tracker.audio,
    loadMs: session.loadMs,
    initializeMs: session.initializeMs,
    diagnostics: session.diagnostics(),
  };
}

/** A failed run terminates the suite; no later workload can conceal its failure. */
export async function runPerformanceAssignments(
  api: PerformanceApi,
  runtime: PerformanceRuntime,
  health = new CaptureHealth(),
): Promise<void> {
  while (true) {
    const assignment = await api.take();
    if (!assignment) return;
    health.beginCase();
    let session: PerformanceSession | undefined;
    let result: PerformanceResult | PreviewPerformanceResult | undefined;
    let failure: string | undefined;
    try {
      validatePerformanceAssignment(assignment);
      session = await runtime.open(assignment, health);
      result =
        assignment.benchmark.mode === "preview-present"
          ? await measurePreviewPerformance(assignment, session)
          : await measurePerformance(assignment, session, (request) => api.output(request));
    } catch (error) {
      failure = captureErrorMessage(error);
    } finally {
      try {
        await session?.dispose();
        health.assertHealthy();
      } catch (error) {
        failure = [failure, captureErrorMessage(error)].filter(Boolean).join("\n");
      }
    }
    if (failure || !result) throw new Error(failure ?? "Benchmark produced no result");
    await api.complete(result);
  }
}
