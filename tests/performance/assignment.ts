import { validateRenderHostAssignment } from "../../src/components/render-host/render-host-session";
import type { Project } from "../../src/core/types";
import { captureComposition } from "../parity/capture-resources";
import type { PerformanceAssignment } from "./protocol";

export function validatePerformanceAssignment(assignment: PerformanceAssignment): void {
  const value = assignment.benchmark;
  if (!value || !/^[a-z0-9-]+$/.test(value.id)) throw new Error("Invalid benchmark identity");
  if (!["readback-only", "ipc-no-encode", "full-mp4", "preview-present"].includes(value.mode))
    throw new Error("Invalid benchmark output mode");
  if (value.requireAudio && value.mode !== "full-mp4")
    throw new Error("Only full MP4 benchmarks may require audio");
  if (!Number.isSafeInteger(value.run) || value.run < 0)
    throw new Error("Invalid benchmark run number");
  if (value.warmupFrames !== 10) throw new Error("Performance runs require ten warm-up frames");
  if (
    !Number.isSafeInteger(value.startFrame) ||
    !Number.isSafeInteger(value.endFrameExclusive) ||
    value.startFrame < 0 ||
    value.endFrameExclusive <= value.startFrame ||
    value.endFrameExclusive - value.startFrame > 10_000_000
  )
    throw new Error("Invalid benchmark frame range");
  if (
    !Number.isSafeInteger(value.frameRate?.numerator) ||
    !Number.isSafeInteger(value.frameRate?.denominator) ||
    value.frameRate.numerator < 1 ||
    value.frameRate.denominator < 1
  )
    throw new Error("Invalid benchmark rational frame rate");
}

export function performanceRenderAssignment(assignment: PerformanceAssignment, project: Project) {
  validatePerformanceAssignment(assignment);
  const composition = captureComposition(assignment, project);
  const { benchmark } = assignment;
  if (
    composition.frameRate.numerator !== benchmark.frameRate.numerator ||
    composition.frameRate.denominator !== benchmark.frameRate.denominator
  )
    throw new Error("Benchmark frame rate differs from the project");
  return validateRenderHostAssignment({
    jobId: benchmark.id,
    leaseId: `benchmark-${benchmark.run}`,
    manifest: {
      id: benchmark.id,
      compositionId: composition.id,
      compositionName: composition.name,
      projectRevision: 0,
      projectSnapshot: JSON.stringify(project),
      ...assignment.case.size,
      antiAliasing: assignment.case.aa,
      frameRate: { ...composition.frameRate },
      startFrame: benchmark.startFrame,
      endFrameExclusive: benchmark.endFrameExclusive,
      outputs: [
        {
          id: "mp4",
          kind: "mp4",
          destination: `${benchmark.id}.mp4`,
          codec: "h264",
          bitrateMbps: 20,
          includeAudio: benchmark.mode === "full-mp4",
        },
      ],
      priority: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
  });
}
