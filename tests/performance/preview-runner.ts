import { frameTimeAtIndex } from "../../src/core/rendering/render-export";
import { validatePerformanceAssignment } from "./assignment";
import type { PerformanceAssignment, PreviewPerformanceResult } from "./protocol";
import type { PerformanceSession } from "./runtime";

/** Measures production canvas rendering through GPU completion, without display pacing or readback. */
export async function measurePreviewPerformance(
  assignment: PerformanceAssignment,
  session: PerformanceSession,
  now: () => number = () => performance.now(),
): Promise<PreviewPerformanceResult> {
  validatePerformanceAssignment(assignment);
  const { benchmark, case: item } = assignment;
  if (benchmark.mode !== "preview-present" || !session.present || !session.complete)
    throw new Error("Preview performance requires a production present session");
  const present = session.present;
  const complete = session.complete;
  const frames = benchmark.endFrameExclusive - benchmark.startFrame;
  const samples: PreviewPerformanceResult["samples"] = [];
  const submit = async (frame: number) => {
    session.assertHealthy();
    const started = now();
    const metrics = present(frameTimeAtIndex(frame, benchmark.frameRate));
    const submitted = now();
    if (
      metrics.mediaPending ||
      metrics.drawCalls < 1 ||
      metrics.passCount < 1 ||
      !Number.isFinite(metrics.drawCalls) ||
      !Number.isFinite(metrics.passCount)
    )
      throw new Error("Preview frame did not submit complete production rendering");
    await complete();
    const ended = now();
    session.assertHealthy();
    if (
      ![started, submitted, ended].every(Number.isFinite) ||
      submitted < started ||
      ended < submitted
    )
      throw new Error("Preview timing sample is invalid");
    return { frame, presentCallMs: submitted - started, presentCompletionMs: ended - started };
  };
  for (let index = 0; index < benchmark.warmupFrames; index++)
    await submit(benchmark.startFrame + (index % frames));
  const started = now();
  for (let frame = benchmark.startFrame; frame < benchmark.endFrameExclusive; frame++)
    samples.push(await submit(frame));
  const elapsedMs = now() - started;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error("Preview duration is invalid");
  return {
    schemaVersion: 1,
    id: benchmark.id,
    benchmarkId: benchmark.id,
    caseId: item.id,
    mode: "preview-present",
    run: benchmark.run,
    frames,
    warmupFrames: benchmark.warmupFrames,
    startFrame: benchmark.startFrame,
    endFrameExclusive: benchmark.endFrameExclusive,
    width: item.size.width,
    height: item.size.height,
    frameRate: { ...benchmark.frameRate },
    pixelFormat: session.pixelFormat,
    maxInFlight: 1,
    playing: false,
    elapsedMs,
    framesPerSecond: (frames * 1000) / elapsedMs,
    samples,
    loadMs: session.loadMs,
    initializeMs: session.initializeMs,
    diagnostics: session.diagnostics(),
  };
}
