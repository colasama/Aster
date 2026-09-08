import { analyzeSpectrum, buildWaveformPeaks } from "../audio/audio-analysis";
import { decodeRadianceHdrForUpload } from "../media/hdr-environment";
import {
  type CpuTask,
  CpuTaskError,
  type CpuTaskResult,
  MAX_CPU_TASK_OUTPUT_CHARACTERS,
} from "./cpu-task-protocol";

export function executeCpuTask<T extends CpuTask>(task: T): CpuTaskResult<T> {
  switch (task.kind) {
    case "serialize-json":
      return serializeJson(task) as CpuTaskResult<T>;
    case "waveform-peaks":
      return buildWaveformPeaks(task.samples, task.binCount) as CpuTaskResult<T>;
    case "spectrum":
      return analyzeSpectrum(task.samples, task.sampleRate, task.options) as CpuTaskResult<T>;
    case "decode-radiance-hdr":
      return decodeRadianceHdrForUpload(
        new Uint8Array(task.source),
        task.metadataOnly,
      ) as CpuTaskResult<T>;
  }
}

function serializeJson(task: Extract<CpuTask, { kind: "serialize-json" }>): string {
  const spacing = task.spacing ?? 0;
  if (!Number.isSafeInteger(spacing) || spacing < 0 || spacing > 10) {
    throw new CpuTaskError("invalid-task", "JSON spacing must be an integer between 0 and 10");
  }
  const maximum = task.maxOutputCharacters ?? MAX_CPU_TASK_OUTPUT_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_CPU_TASK_OUTPUT_CHARACTERS) {
    throw new CpuTaskError(
      "invalid-task",
      `JSON output limit must be between 1 and ${MAX_CPU_TASK_OUTPUT_CHARACTERS} characters`,
    );
  }
  const serialized = JSON.stringify(task.value, null, spacing);
  if (serialized === undefined) {
    throw new CpuTaskError("not-serializable", "The task value has no JSON representation");
  }
  const output = task.trailingNewline ? `${serialized}\n` : serialized;
  if (output.length > maximum) {
    throw new CpuTaskError("output-too-large", `JSON output exceeds ${maximum} characters`);
  }
  return output;
}
