import { MAX_SOURCE_DIMENSION, MAX_SOURCE_DURATION } from "../../media/footage-source";

import type { FootageSource } from "../../types";

import { requireFiniteNumber, requireObject, requirePositiveNumber, requireString } from "./values";

export const MAX_EMBEDDED_ASSET_CHARACTERS = 136 * 1024 * 1024;

export function validateFootageSource(
  value: unknown,
  path: string,
): asserts value is FootageSource {
  const source = requireObject(value, path);
  if (requireString(source.id, `${path}.id`).length > 256)
    throw new Error(`${path}.id is too long`);
  const name = requireString(source.name, `${path}.name`);
  if (!name.trim() || name.length > 512) throw new Error(`${path}.name is too long`);
  if (requireString(source.mimeType, `${path}.mimeType`).length > 256)
    throw new Error(`${path}.mimeType is too long`);
  if (requireString(source.contentIdentity, `${path}.contentIdentity`).length > 256)
    throw new Error(`${path}.contentIdentity is too long`);
  if (!["still", "video", "audio", "imageSequence", "svg", "psd"].includes(String(source.kind)))
    throw new Error(`${path}.kind is unsupported`);
  if (["still", "video", "imageSequence", "svg", "psd"].includes(String(source.kind))) {
    for (const field of ["width", "height"] as const) {
      const dimension = requireFiniteNumber(source[field], `${path}.${field}`);
      if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_SOURCE_DIMENSION)
        throw new Error(
          `${path}.${field} must be an integer from 1 through ${MAX_SOURCE_DIMENSION}`,
        );
    }
  }
  if (source.kind === "video" || source.kind === "audio") {
    const duration = requirePositiveNumber(source.duration, `${path}.duration`);
    if (duration > MAX_SOURCE_DURATION)
      throw new Error(`${path}.duration exceeds the supported range`);
  }
  if (source.kind === "audio") {
    const channels = requireFiniteNumber(source.channels, `${path}.channels`);
    const sampleRate = requireFiniteNumber(source.sampleRate, `${path}.sampleRate`);
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 32)
      throw new Error(`${path}.channels must be an integer from 1 through 32`);
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000)
      throw new Error(`${path}.sampleRate is unsupported`);
    const streamIndex = requireFiniteNumber(source.streamIndex, `${path}.streamIndex`);
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex >= 128)
      throw new Error(`${path}.streamIndex is unsupported`);
  }
  if (source.kind === "video" && source.audio !== undefined) {
    const audio = requireObject(source.audio, `${path}.audio`);
    for (const field of ["streamIndex", "channels", "sampleRate"] as const) {
      const value = requireFiniteNumber(audio[field], `${path}.audio.${field}`);
      if (!Number.isSafeInteger(value))
        throw new Error(`${path}.audio.${field} must be an integer`);
    }
    if ((audio.streamIndex as number) < 0 || (audio.streamIndex as number) >= 128)
      throw new Error(`${path}.audio.streamIndex is unsupported`);
    if ((audio.channels as number) < 1 || (audio.channels as number) > 32)
      throw new Error(`${path}.audio.channels is unsupported`);
    if ((audio.sampleRate as number) < 8_000 || (audio.sampleRate as number) > 384_000)
      throw new Error(`${path}.audio.sampleRate is unsupported`);
  }
  if (source.kind === "imageSequence") {
    if (requireString(source.pattern, `${path}.pattern`).trim().length === 0)
      throw new Error(`${path}.pattern must not be blank`);
    if (String(source.pattern).length > 1024) throw new Error(`${path}.pattern is too long`);
    const startFrame = requireFiniteNumber(source.startFrame, `${path}.startFrame`);
    const endFrame = requireFiniteNumber(source.endFrame, `${path}.endFrame`);
    if (
      !Number.isSafeInteger(startFrame) ||
      !Number.isSafeInteger(endFrame) ||
      endFrame < startFrame
    )
      throw new Error(`${path} has an invalid frame range`);
  }
  if (source.kind === "psd") {
    const layerCount = requireFiniteNumber(source.layerCount, `${path}.layerCount`);
    if (!Number.isSafeInteger(layerCount) || layerCount < 1 || layerCount > 10_000)
      throw new Error(`${path}.layerCount must be an integer from 1 through 10000`);
  }
  const interpretation = requireObject(source.interpretation, `${path}.interpretation`);
  if (!["straight", "premultiplied", "ignore"].includes(String(interpretation.alpha)))
    throw new Error(`${path}.interpretation.alpha is unsupported`);
  if (!["srgb", "linear", "display-p3"].includes(String(interpretation.colorSpace)))
    throw new Error(`${path}.interpretation.colorSpace is unsupported`);
  if (interpretation.frameRate !== undefined) {
    const frameRate = requireObject(interpretation.frameRate, `${path}.interpretation.frameRate`);
    for (const field of ["numerator", "denominator"] as const) {
      const rate = requirePositiveNumber(
        frameRate[field],
        `${path}.interpretation.frameRate.${field}`,
      );
      if (!Number.isSafeInteger(rate) || rate > 240_000)
        throw new Error(`${path}.interpretation.frameRate.${field} is unsupported`);
    }
  }
  if (source.relativePath !== undefined) {
    const relativePath = requireString(source.relativePath, `${path}.relativePath`);
    if (
      relativePath.length > 1024 ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "..") ||
      relativePath.startsWith("/")
    )
      throw new Error(`${path}.relativePath must stay inside the project bundle`);
  }
  if (
    source.runtimeUrl !== undefined &&
    requireString(source.runtimeUrl, `${path}.runtimeUrl`).length > 4096
  )
    throw new Error(`${path}.runtimeUrl is too long`);
  if (source.dataUrl === undefined) return;
  const dataUrl = requireString(source.dataUrl, `${path}.dataUrl`);
  if (!dataUrl.startsWith("data:") || dataUrl.length > MAX_EMBEDDED_ASSET_CHARACTERS)
    throw new Error(`${path}.dataUrl must be a bounded embedded data URL`);
}
