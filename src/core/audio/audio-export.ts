import type { Composition, FootageSource, Id, Project } from "../types";
import { audibleCompositionLayers, type DecodedPcm, mixCompositionAudio } from "./audio-mixer";

export const EXPORT_AUDIO_SAMPLE_RATE = 48_000;
export const EXPORT_AUDIO_CHUNK_FRAMES = 48_000;

type AudioFootageSource = Extract<FootageSource, { kind: "audio" | "video" }>;
export type AudioSourceDecoder = (source: AudioFootageSource) => Promise<DecodedPcm>;

/** Keeps PCM duration derived from the same rational frame clock used by the video encoder. */
export function alignedAudioFrameCount(
  videoFrameCount: number,
  frameRate: { numerator: number; denominator: number },
  sampleRate = EXPORT_AUDIO_SAMPLE_RATE,
): number {
  if (!Number.isSafeInteger(videoFrameCount) || videoFrameCount < 1)
    throw new RangeError("Video frame count must be a positive safe integer");
  if (
    !Number.isSafeInteger(frameRate.numerator) ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.numerator < 1 ||
    frameRate.denominator < 1 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000
  )
    throw new RangeError("Audio export requires bounded rational timing");
  const frames = Math.round(
    (videoFrameCount / frameRate.numerator) * frameRate.denominator * sampleRate,
  );
  if (!Number.isSafeInteger(frames) || frames < 1)
    throw new RangeError("Audio export frame count exceeds the safe integer range");
  return frames;
}

/** Decodes each audible source once even when multiple layer instances reference it. */
export async function decodeAudibleSources(
  project: Project,
  composition: Composition,
  decode: AudioSourceDecoder,
): Promise<Map<Id, DecodedPcm>> {
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const sourceIds = new Set(
    audibleCompositionLayers(composition)
      .map((layer) => layer.sourceId)
      .filter((sourceId): sourceId is Id => sourceId !== undefined),
  );
  const decoded = new Map<Id, DecodedPcm>();
  await Promise.all(
    [...sourceIds].map(async (sourceId) => {
      const source = sourceById.get(sourceId);
      if (!source || (source.kind !== "audio" && source.kind !== "video"))
        throw new Error(`Audible layer source ${sourceId} is unavailable`);
      decoded.set(sourceId, await decode(source));
    }),
  );
  return decoded;
}

/** Mixes one bounded interleaved stereo chunk and pads past composition duration with silence. */
export function mixAudioExportChunk(
  project: Project,
  composition: Composition,
  decodedBySourceId: ReadonlyMap<Id, DecodedPcm>,
  startFrame: number,
  frameCount: number,
  sampleRate = EXPORT_AUDIO_SAMPLE_RATE,
  compositionStartTime = 0,
): Float32Array {
  if (
    !Number.isSafeInteger(startFrame) ||
    startFrame < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > EXPORT_AUDIO_CHUNK_FRAMES
  )
    throw new RangeError("Audio export chunk is outside its bounded frame range");
  if (
    !Number.isFinite(compositionStartTime) ||
    compositionStartTime < 0 ||
    compositionStartTime > composition.duration
  )
    throw new RangeError("Audio export composition start time is outside the composition");
  const output = new Float32Array(frameCount * 2);
  const startTime = compositionStartTime + startFrame / sampleRate;
  if (startTime >= composition.duration) return output;
  const endTime = Math.min(
    composition.duration,
    compositionStartTime + (startFrame + frameCount) / sampleRate,
  );
  const mixed = mixCompositionAudio(project, composition, decodedBySourceId, {
    startTime,
    endTime,
    sampleRate,
    clipProtection: "limit",
  });
  output.set(mixed.samples.subarray(0, output.length));
  return output;
}

export async function streamCompositionAudio(
  project: Project,
  composition: Composition,
  decodedBySourceId: ReadonlyMap<Id, DecodedPcm>,
  totalFrames: number,
  write: (samples: Float32Array, startFrame: number) => Promise<void>,
  cancelled: () => boolean,
  sampleRate = EXPORT_AUDIO_SAMPLE_RATE,
  compositionStartTime = 0,
): Promise<number> {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1)
    throw new RangeError("Audio export total must be a positive safe integer");
  let completed = 0;
  while (completed < totalFrames && !cancelled()) {
    const frameCount = Math.min(EXPORT_AUDIO_CHUNK_FRAMES, totalFrames - completed);
    const samples = mixAudioExportChunk(
      project,
      composition,
      decodedBySourceId,
      completed,
      frameCount,
      sampleRate,
      compositionStartTime,
    );
    if (cancelled()) break;
    await write(samples, completed);
    completed += frameCount;
  }
  return completed;
}
