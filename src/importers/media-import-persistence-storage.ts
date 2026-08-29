import { convertFileSrc } from "../desktop/api";
import { mediaBytesIdentity } from "./media-import-identity";
import {
  type HydrateMediaImportOptions,
  MAX_PORTABLE_MEDIA_BYTES,
  type PersistedMediaStorage,
} from "./media-import-persistence-codec";

export async function loadStorage(
  storage: PersistedMediaStorage,
  options: HydrateMediaImportOptions,
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (storage.kind === "inline") {
    const bytes = decodeBase64(storage.data, path);
    assertIdentity(storage.byteIdentity, mediaBytesIdentity(bytes), `${path}.byteIdentity`);
    return bytes;
  }
  if (storage.kind === "external")
    throw new Error(`${path} contains an unsaved external media path`);
  if (!options.allowResolvedPaths || !storage.resolvedPath)
    throw new Error(`${path} relative media is unavailable outside its project bundle`);
  const bytes = await fetchRuntimeBytes(convertFileSrc(storage.resolvedPath), path, maximumBytes);
  assertIdentity(storage.byteIdentity, mediaBytesIdentity(bytes), `${path}.byteIdentity`);
  return bytes;
}

export async function runtimeUrlForStorage(
  storage: PersistedMediaStorage,
  options: HydrateMediaImportOptions,
  path: string,
): Promise<{ url: string; dispose?: () => void }> {
  if (storage.kind === "inline") {
    const bytes = decodeBase64(storage.data, path);
    assertIdentity(storage.byteIdentity, mediaBytesIdentity(bytes), `${path}.byteIdentity`);
    const url = URL.createObjectURL(new Blob([exactArrayBuffer(bytes)]));
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }
  if (storage.kind === "external")
    throw new Error(`${path} contains an unsaved external media path`);
  if (!options.allowResolvedPaths || !storage.resolvedPath)
    throw new Error(`${path} image sequence frame is missing from the project bundle`);
  return { url: convertFileSrc(storage.resolvedPath) };
}

export function storageByteIdentity(storage: PersistedMediaStorage): string | undefined {
  return storage.kind === "external" ? storage.byteIdentity : storage.byteIdentity;
}

export function resolvedStoragePath(
  storage: PersistedMediaStorage,
  options: HydrateMediaImportOptions,
): string | undefined {
  return storage.kind === "relative" && options.allowResolvedPaths
    ? storage.resolvedPath
    : undefined;
}

export function inlineStorage(bytes: Uint8Array): PersistedMediaStorage {
  return { kind: "inline", byteIdentity: mediaBytesIdentity(bytes), data: encodeBase64(bytes) };
}

export function chargePortableBudget(budget: { bytes: number }, bytes: number): void {
  budget.bytes += bytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_PORTABLE_MEDIA_BYTES)
    throw new Error("Self-contained advanced media payloads exceed 128 MiB");
}

export async function fetchRuntimeBytes(
  url: string,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} is unavailable (HTTP ${response.status})`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    throw new Error(`${label} exceeds the payload size limit`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds the payload size limit`);
  return bytes;
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

function decodeBase64(value: string, path: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${path} is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function assertIdentity(expected: string, actual: string, label: string): void {
  if (expected !== actual) throw new Error(`${label} identity mismatch`);
}
