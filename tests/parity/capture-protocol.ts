import type { GpuDiagnostics, Project } from "../../src/core/types";
import type { BundleResource } from "../../src/renderer/frame-plan/precomposition-bundle-resources";
import type { RasterFrameCapture } from "../../src/renderer/media/raster-resource-capture";
import type { CaptureFontFingerprint } from "./capture-fonts";
import type { ParityCase } from "./types";

export interface ParityFramePlan {
  caseId: string;
  frame: number;
  diagnostics: GpuDiagnostics;
  submitted: Uint8Array;
  replay: Uint8Array;
  resources: readonly BundleResource[];
}

export interface ParityFramePlanReceipt {
  submitted_sha256: string;
  replay_sha256: string;
}

export interface ParityPlanSample {
  index: number;
  kind: "declared" | "random";
  frame?: number;
  time: number;
}
export interface ParityPlanSchedule {
  schema_version: 1;
  algorithm: "sha256-u53-v1";
  seed: string;
  composition: string;
  duration: number;
  frame_rate: { numerator: number; denominator: number };
  random_count: 64;
  samples: ParityPlanSample[];
}
export interface ParityCapturedPlan {
  caseId: string;
  frame: number;
  time: number;
  frameRate: { numerator: number; denominator: number };
  diagnostics: GpuDiagnostics;
  framePlan: ParityFramePlanReceipt;
  project?: Project;
}
export interface ParityCaptureAssignment {
  case: ParityCase;
  frames: number[];
  planSamples?: ParityPlanSchedule;
  projectPath: string;
  caseHash: string;
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
  framePlan?: ParityFramePlanReceipt;
  /** Live production pixels used only to verify independently replayed diagnostic candidates. */
  temporalReplay?: { passes: number; samples: number };
  productionPixels?: ArrayBuffer;
  rasterCapture?: RasterFrameCapture;
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
  prepareFrame?(
    frame: ParityFramePlan,
  ): Promise<{ plan: Uint8Array; receipt: ParityFramePlanReceipt }>;
  plan?(frame: ParityCapturedPlan): Promise<void>;
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
