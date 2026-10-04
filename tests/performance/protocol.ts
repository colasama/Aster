import type { GpuDiagnostics } from "../../src/core/types";
import type { DesktopRenderHostOutputRequest, Mp4PixelFormat } from "../../src/desktop/api";
import type { ParityAdapterIdentity, ParityCaptureAssignment } from "../parity/capture-protocol";

export type PerformanceMode = "readback-only" | "ipc-no-encode" | "full-mp4";
export type BenchmarkMode = PerformanceMode | "preview-present";

export interface PerformanceAssignment extends ParityCaptureAssignment {
  benchmark: {
    id: string;
    mode: BenchmarkMode;
    run: number;
    warmupFrames: number;
    startFrame: number;
    endFrameExclusive: number;
    frameRate: { numerator: number; denominator: number };
    requireAudio?: boolean;
  };
}

export interface PerformanceResult {
  schemaVersion: 1;
  id: string;
  benchmarkId: string;
  caseId: string;
  mode: PerformanceMode;
  run: number;
  frames: number;
  warmupFrames: number;
  startFrame: number;
  endFrameExclusive: number;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  pixelFormat: Mp4PixelFormat;
  synchronizeVideo: boolean;
  maxInFlight: number;
  elapsedMs: number;
  framesPerSecond: number;
  frameCompletionIntervalsMs: number[];
  readbackWallLatenciesMs: number[];
  outputInvokeLatenciesMs: { type: DesktopRenderHostOutputRequest["type"]; elapsedMs: number }[];
  audio: { enabled: true; frameCount: number; sampleRate: number; channels: 2 } | null;
  loadMs: number;
  initializeMs: number;
  diagnostics: GpuDiagnostics;
}

export interface PerformanceApi {
  ready(adapter: ParityAdapterIdentity): Promise<void>;
  take(): Promise<PerformanceAssignment | null>;
  output(request: DesktopRenderHostOutputRequest): Promise<unknown>;
  complete(result: PerformanceResult | PreviewPerformanceResult): Promise<void>;
  fail(failure: { error: string }): Promise<void>;
  done(): Promise<void>;
}

export interface PreviewPerformanceResult {
  schemaVersion: 1;
  id: string;
  benchmarkId: string;
  caseId: string;
  mode: "preview-present";
  run: number;
  frames: number;
  warmupFrames: number;
  startFrame: number;
  endFrameExclusive: number;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  pixelFormat: Mp4PixelFormat;
  maxInFlight: 1;
  playing: false;
  elapsedMs: number;
  framesPerSecond: number;
  samples: { frame: number; presentCallMs: number; presentCompletionMs: number }[];
  loadMs: number;
  initializeMs: number;
  diagnostics: GpuDiagnostics;
}

declare global {
  interface Window {
    asterPerformance?: PerformanceApi;
  }
}
