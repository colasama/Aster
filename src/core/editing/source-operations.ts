import type { FootageSource, SourceInterpretation } from "../types";
import { clamp } from "./operation-guards";

export function copySourceForOperation(source: FootageSource): FootageSource {
  return {
    ...source,
    interpretation: { ...source.interpretation },
    ...(source.kind === "video" && source.audio ? { audio: { ...source.audio } } : {}),
  } as FootageSource;
}

export function normalizeSourceInterpretation(
  interpretation: SourceInterpretation,
): SourceInterpretation {
  if (!["straight", "premultiplied", "ignore"].includes(interpretation.alpha))
    throw new Error("Footage alpha interpretation is invalid");
  if (!["srgb", "linear", "display-p3"].includes(interpretation.colorSpace))
    throw new Error("Footage color-space interpretation is invalid");
  return {
    alpha: interpretation.alpha,
    colorSpace: interpretation.colorSpace,
    ...(interpretation.frameRate
      ? {
          frameRate: {
            numerator: Math.round(
              clamp(interpolationRate(interpretation.frameRate.numerator), 1, 240_000),
            ),
            denominator: Math.round(
              clamp(interpolationRate(interpretation.frameRate.denominator), 1, 240_000),
            ),
          },
        }
      : {}),
  };
}

function interpolationRate(value: number): number {
  return Number.isFinite(value) ? value : 1;
}

export function assertOperationalSource(source: FootageSource): void {
  if (!source.id || source.id.length > 256 || !source.name.trim() || source.name.length > 512)
    throw new Error("Footage source identity is invalid");
  if (
    !["still", "video", "audio", "imageSequence", "svg", "psd"].includes(source.kind) ||
    !source.mimeType ||
    source.mimeType.length > 256
  )
    throw new Error("Footage source type is invalid");
  assertSourceLocator(
    source.contentIdentity,
    source.dataUrl,
    source.relativePath,
    source.runtimeUrl,
  );
  if (
    "width" in source &&
    (!Number.isSafeInteger(source.width) || source.width < 1 || source.width > 30_000)
  )
    throw new Error("Footage source width is invalid");
  if (
    "height" in source &&
    (!Number.isSafeInteger(source.height) || source.height < 1 || source.height > 30_000)
  )
    throw new Error("Footage source height is invalid");
  if (
    "duration" in source &&
    (!Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 86_400)
  )
    throw new Error("Footage source duration is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.channels) || source.channels < 1 || source.channels > 32)
  )
    throw new Error("Footage source channel count is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.sampleRate) ||
      source.sampleRate < 8_000 ||
      source.sampleRate > 384_000)
  )
    throw new Error("Footage source sample rate is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.streamIndex) ||
      source.streamIndex < 0 ||
      source.streamIndex >= 128)
  )
    throw new Error("Footage source stream index is invalid");
  if (source.kind === "video" && source.audio) {
    if (
      !Number.isSafeInteger(source.audio.streamIndex) ||
      source.audio.streamIndex < 0 ||
      source.audio.streamIndex >= 128 ||
      !Number.isSafeInteger(source.audio.channels) ||
      source.audio.channels < 1 ||
      source.audio.channels > 32 ||
      !Number.isSafeInteger(source.audio.sampleRate) ||
      source.audio.sampleRate < 8_000 ||
      source.audio.sampleRate > 384_000
    )
      throw new Error("Video source audio metadata is invalid");
  }
  if (
    source.kind === "imageSequence" &&
    (!source.pattern ||
      source.pattern.length > 1024 ||
      !Number.isSafeInteger(source.startFrame) ||
      !Number.isSafeInteger(source.endFrame) ||
      source.endFrame < source.startFrame)
  )
    throw new Error("Footage source sequence range is invalid");
  if (
    source.kind === "psd" &&
    (!Number.isSafeInteger(source.layerCount) ||
      source.layerCount < 1 ||
      source.layerCount > 10_000)
  )
    throw new Error("Footage source PSD layer count is invalid");
  normalizeSourceInterpretation(source.interpretation);
}

export function assertSourceLocator(
  contentIdentity: string,
  dataUrl?: string,
  relativePath?: string,
  runtimeUrl?: string,
): void {
  if (!contentIdentity || contentIdentity.length > 256)
    throw new Error("Footage content identity is invalid");
  if (dataUrl && (!dataUrl.startsWith("data:") || dataUrl.length > 136 * 1024 * 1024))
    throw new Error("Footage embedded data is invalid");
  if (
    relativePath &&
    (relativePath.length > 1024 ||
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((segment) => segment === ".."))
  )
    throw new Error("Footage relative path is invalid");
  if (runtimeUrl && runtimeUrl.length > 4096) throw new Error("Footage runtime URL is invalid");
}
