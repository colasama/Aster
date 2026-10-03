import type { GpuDiagnostics } from "../../src/core/types";
import type { CaptureFontFingerprint } from "./capture-fonts";
import type { ParityCase } from "./types";

export interface ParityCaptureAssignment {
  case: ParityCase;
  frames: number[];
  projectPath: string;
}

export interface ParityCapturedFrame {
  caseId: string;
  frame: number;
  time: number;
  frameRate: { numerator: number; denominator: number };
  width: number;
  height: number;
  /** Packed RGBA8 beauty bytes, without Canvas 2D conversion or PNG encoding. */
  pixels: ArrayBuffer;
  diagnostics: GpuDiagnostics;
  timings: { load_ms: number; initialize_ms: number; readback_ms: number };
}

export interface ParityCaseCompletion {
  caseId: string;
  diagnostics: GpuDiagnostics;
  elapsed_ms: number;
}

export interface ParityAdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter?: boolean;
  fonts: CaptureFontFingerprint;
}

export interface ParityCaptureApi {
  ready(adapter: ParityAdapterIdentity): Promise<void>;
  take(): Promise<ParityCaptureAssignment | null>;
  frame(frame: ParityCapturedFrame): Promise<void>;
  completeCase(result: ParityCaseCompletion): Promise<void>;
  fail(failure: { caseId?: string; error: string }): Promise<void>;
  done(): Promise<void>;
}

declare global {
  interface Window {
    asterParity?: ParityCaptureApi;
  }
}
