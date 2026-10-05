import { frameTimeAtIndex } from "../../src/core/rendering/render-export";
import type { Composition, GpuDiagnostics } from "../../src/core/types";
import type { RasterFrameCapture } from "../../src/renderer/media/raster-resource-capture";
import { CaptureHealth, captureErrorMessage } from "./capture-health";
import type { ParityCaptureApi, ParityCaptureAssignment } from "./capture-protocol";

export interface CaptureSession {
  composition: Composition;
  load_ms: number;
  initialize_ms: number;
  diagnostics(): GpuDiagnostics;
  assertHealthy(): void;
  readback(time: number): Promise<ArrayBuffer>;
  temporalReplay?(): { passes: number; samples: number };
  productionPixels?(): ArrayBuffer | undefined;
  captureRasters?(): Promise<RasterFrameCapture>;
  dispose(): Promise<void>;
}

export interface CaptureRuntime {
  open(assignment: ParityCaptureAssignment, health: CaptureHealth): Promise<CaptureSession>;
}

/** Keeps frame addresses ordered and only acknowledges a case after successful cleanup. */
export async function runCaptureAssignments(
  api: ParityCaptureApi,
  runtime: CaptureRuntime,
  health = new CaptureHealth(),
  now: () => number = () => performance.now(),
): Promise<void> {
  while (true) {
    const assignment = await api.take();
    if (!assignment) break;
    const started = now();
    health.beginCase();
    let session: CaptureSession | undefined;
    let failure: string | undefined;
    let diagnostics: GpuDiagnostics | undefined;
    try {
      session = await runtime.open(assignment, health);
      for (const frame of assignment.frames) {
        session.assertHealthy();
        const time = frameTimeAtIndex(frame, session.composition.frameRate);
        const readbackStarted = now();
        const pixels = await session.readback(time);
        const readback_ms = now() - readbackStarted;
        session.assertHealthy();
        if (pixels.byteLength !== assignment.case.size.width * assignment.case.size.height * 4)
          throw new Error("Capture returned an invalid RGBA byte length");
        await api.frame({
          caseId: assignment.case.id,
          frame,
          time,
          frameRate: { ...session.composition.frameRate },
          ...assignment.case.size,
          pixels,
          temporalReplay: session.temporalReplay?.(),
          productionPixels: session.productionPixels?.(),
          rasterCapture: await session.captureRasters?.(),
          diagnostics: session.diagnostics(),
          timings: { load_ms: session.load_ms, initialize_ms: session.initialize_ms, readback_ms },
        });
        session.assertHealthy();
      }
      diagnostics = session.diagnostics();
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
    if (failure || !diagnostics) {
      await api.fail({
        caseId: assignment.case.id,
        error: failure ?? "Capture produced no diagnostics",
      });
      if (health.fatal) break;
    } else {
      await api.completeCase({
        caseId: assignment.case.id,
        diagnostics,
        elapsed_ms: now() - started,
      });
    }
  }
  await api.done();
}
