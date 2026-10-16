import { runRenderHostFrameLoop } from "../../src/components/render-host/render-host-session";
import { decodeAudibleSources } from "../../src/core/audio/audio-export";
import { frameTimeAtIndex } from "../../src/core/rendering/render-export";
import type { NativePerformanceResult, PerformanceApi, PerformanceAssignment } from "./protocol";
import type { PerformanceSession } from "./runtime";

/** Measure real native admission through durable MP4 completion; fallback cannot enter this arm. */
export async function measureNativePerformance(
  assignment: PerformanceAssignment,
  session: PerformanceSession,
  api: PerformanceApi,
): Promise<NativePerformanceResult> {
  const { benchmark } = assignment;
  const { manifest } = session.validated;
  const frames = benchmark.endFrameExclusive - benchmark.startFrame;
  if (
    benchmark.renderer !== "rust" ||
    benchmark.mode !== "full-mp4" ||
    benchmark.warmupFrames !== 10 ||
    !api.nativePrepare ||
    !api.nativeWarm ||
    !session.planFrame
  )
    throw new Error("Native benchmark preparation is unavailable");
  await api.nativePrepare(manifest);
  for (let index = 0; index < 10; index++) {
    session.assertHealthy();
    const frame = index % frames;
    await api.nativeWarm(
      frame,
      await session.planFrame(frameTimeAtIndex(benchmark.startFrame + frame, manifest.frameRate)),
    );
  }
  const frameCompletionIntervalsMs: number[] = [];
  const planWallLatenciesMs = new Array<number>(frames);
  const outputInvokeLatenciesMs: NativePerformanceResult["outputInvokeLatenciesMs"] = [];
  let preparedAt: number | undefined,
    completedAt: number | undefined,
    lastProgressAt: number | undefined;
  let audio: NativePerformanceResult["audio"] = null;
  const plan = session.planFrame;
  // The retained TS interval begins after audio decoding. Use the same production decoder
  // before timing, then let the production loop consume exactly these source-bound PCM buffers.
  if (!session.audioDecoder) throw new Error("Native MP4 benchmark requires an audio decoder");
  const decoded = await decodeAudibleSources(
    session.validated.project,
    session.validated.composition,
    session.audioDecoder,
  );
  const result = await runRenderHostFrameLoop({
    assignment: session.validated,
    pixelFormat: session.pixelFormat,
    audioDecoder: async (source) => {
      const pcm = decoded.get(source.id);
      if (!pcm) throw new Error("Native benchmark audio was not prepared for this source");
      return pcm;
    },
    requestedControl: () => undefined,
    planFrame: async (frame, time, retained) => {
      session.assertHealthy();
      const started = performance.now();
      const packet = await plan(time, retained);
      planWallLatenciesMs[frame - benchmark.startFrame] = performance.now() - started;
      return packet;
    },
    renderFrame: async () => {
      throw new Error("Native benchmark fell back to TS rendering");
    },
    encodePng: async () => {
      throw new Error("Native benchmark requested PNG output");
    },
    output: async (request) => {
      session.assertHealthy();
      const started = performance.now();
      const response = await api.output(request);
      outputInvokeLatenciesMs.push({ type: request.type, elapsedMs: performance.now() - started });
      if (request.type === "startMp4" && request.audio) audio = { enabled: true, ...request.audio };
      return response;
    },
    report: async (report) => {
      const time = performance.now();
      if (report.type === "prepared") {
        if (preparedAt !== undefined) throw new Error("Native benchmark was prepared twice");
        preparedAt = lastProgressAt = time;
      } else if (report.type === "progress") {
        if (
          lastProgressAt === undefined ||
          report.progress.completedFrames !== frameCompletionIntervalsMs.length + 1 ||
          report.progress.totalFrames !== frames
        )
          throw new Error("Native benchmark progress is missing or out of order");
        frameCompletionIntervalsMs.push(time - lastProgressAt);
        lastProgressAt = time;
      } else if (report.type === "completed") completedAt = time;
      else throw new Error(`Unexpected native benchmark state: ${report.type}`);
    },
  });
  session.assertHealthy();
  if (
    result !== "completed" ||
    preparedAt === undefined ||
    completedAt === undefined ||
    frameCompletionIntervalsMs.length !== frames ||
    Array.from(planWallLatenciesMs).some((time) => !Number.isFinite(time) || time < 0)
  )
    throw new Error("Native benchmark measurements are incomplete");
  const elapsedMs = completedAt - preparedAt;
  return {
    schemaVersion: 1,
    renderer: "rust",
    id: benchmark.id,
    benchmarkId: benchmark.id,
    caseId: assignment.case.id,
    mode: "full-mp4",
    run: benchmark.run,
    frames,
    warmupFrames: 10,
    startFrame: benchmark.startFrame,
    endFrameExclusive: benchmark.endFrameExclusive,
    width: manifest.width,
    height: manifest.height,
    frameRate: { ...manifest.frameRate },
    pixelFormat: session.pixelFormat,
    synchronizeVideo: session.validated.synchronizeVideo,
    maxInFlight: 1,
    elapsedMs,
    framesPerSecond: (frames * 1000) / elapsedMs,
    frameCompletionIntervalsMs,
    planWallLatenciesMs,
    outputInvokeLatenciesMs,
    audio,
    loadMs: session.loadMs,
    initializeMs: session.initializeMs,
    diagnostics: session.diagnostics(),
  };
}
