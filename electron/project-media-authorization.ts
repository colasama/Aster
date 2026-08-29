import { isAbsolute, resolve } from "node:path";
import { renderPathKey } from "./render-queue-paths.js";

const MAX_MEDIA_PAYLOADS = 50_000;
const MAX_SEQUENCE_FRAMES = 4_096;
const MAX_PATH_LENGTH = 4_096;

interface ProjectMediaAuthorizationOptions {
  allowedAssets: ReadonlyMap<string, string>;
}

/** Authorizes renderer-provided external media before the native bridge can read local files. */
export function authorizeProjectMediaExternalPaths(
  project: unknown,
  options: ProjectMediaAuthorizationOptions,
): void {
  if (!isRecord(project)) throw new Error("Project document must be an object");
  if (project.mediaImports === undefined) return;
  const sidecar = requireRecord(project.mediaImports, "mediaImports");
  const payloads = requireBoundedArray(
    sidecar.payloads,
    "mediaImports.payloads",
    MAX_MEDIA_PAYLOADS,
  );
  for (const [payloadIndex, value] of payloads.entries()) {
    const path = `mediaImports.payloads[${payloadIndex}]`;
    const payload = requireRecord(value, path);
    if (payload.kind === "svg" || payload.kind === "psd") {
      authorizeStorage(payload.storage, `${path}.storage`, options);
      continue;
    }
    if (payload.kind !== "imageSequence") throw new Error(`${path}.kind is unsupported`);
    const frames = requireBoundedArray(payload.frames, `${path}.frames`, MAX_SEQUENCE_FRAMES);
    for (const [frameIndex, frameValue] of frames.entries()) {
      const frame = requireRecord(frameValue, `${path}.frames[${frameIndex}]`);
      authorizeStorage(frame.storage, `${path}.frames[${frameIndex}].storage`, options);
    }
  }
}

function authorizeStorage(
  value: unknown,
  path: string,
  options: ProjectMediaAuthorizationOptions,
): void {
  const storage = requireRecord(value, path);
  if (storage.kind !== "external") return;
  if (
    typeof storage.externalPath !== "string" ||
    storage.externalPath.length < 1 ||
    storage.externalPath.length > MAX_PATH_LENGTH ||
    !isAbsolute(storage.externalPath)
  )
    throw new Error(`${path}.externalPath must be an absolute bounded path`);
  const requested = resolve(storage.externalPath);
  const authorized = options.allowedAssets.get(renderPathKey(requested));
  if (!authorized || renderPathKey(authorized) !== renderPathKey(requested))
    throw new Error(`${path}.externalPath was not selected by the user`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireBoundedArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${path} must be a bounded array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
