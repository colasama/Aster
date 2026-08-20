import type { SpectrumOptions } from "./audio-analysis";

export const MAX_CPU_TASK_OUTPUT_CHARACTERS = 256 * 1024 * 1024;

export interface SerializeJsonCpuTask {
  kind: "serialize-json";
  value: unknown;
  spacing?: number;
  trailingNewline?: boolean;
  maxOutputCharacters?: number;
}

export interface WaveformPeaksCpuTask {
  kind: "waveform-peaks";
  samples: Float32Array;
  binCount: number;
}

export interface SpectrumCpuTask {
  kind: "spectrum";
  samples: Float32Array;
  sampleRate: number;
  options?: SpectrumOptions;
}

export type CpuTask = SerializeJsonCpuTask | WaveformPeaksCpuTask | SpectrumCpuTask;

export type CpuTaskResult<T extends CpuTask> = T extends SerializeJsonCpuTask
  ? string
  : T extends WaveformPeaksCpuTask | SpectrumCpuTask
    ? Float32Array
    : never;

export interface CpuTaskRequest {
  id: number;
  task: CpuTask;
}

export interface SerializedCpuTaskError {
  code: string;
  message: string;
  name: string;
}

export type CpuTaskResponse =
  | { id: number; ok: true; result: string | Float32Array }
  | { error: SerializedCpuTaskError; id: number; ok: false };

export function serializeCpuTaskError(error: unknown): SerializedCpuTaskError {
  if (error instanceof CpuTaskError) {
    return { code: error.code, message: error.message, name: error.name };
  }
  if (error instanceof Error) {
    return { code: "task-failed", message: error.message, name: error.name };
  }
  return { code: "task-failed", message: String(error), name: "Error" };
}

export class CpuTaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, name = "CpuTaskError") {
    super(message);
    this.code = code;
    this.name = name;
  }
}

export function deserializeCpuTaskError(error: SerializedCpuTaskError): CpuTaskError {
  return new CpuTaskError(error.code, error.message, error.name);
}
