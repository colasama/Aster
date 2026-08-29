import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { renderPathKey } from "./render-queue-paths.js";

interface AuthorizationOptions {
  allowedAssets: Map<string, string>;
  /** Job-owned directory. When present, every linked locator is copied here before enqueue. */
  snapshotDirectory?: string;
  /** Launch-time root constraint. Persisted manifests may not reauthorize arbitrary local roots. */
  expectedSnapshotDirectory?: string;
}

interface RenderMediaLocatorRecord extends Record<string, unknown> {
  kind: unknown;
}

interface LocatedRenderMedia {
  locator: RenderMediaLocatorRecord;
  contentIdentity?: string;
  expectedFile?: { size: number; lastModified: number };
  allowDerivedIdentity?: boolean;
  rewriteContentIdentity?: (identity: string) => void;
}

export interface AuthorizedRenderMediaPath {
  path: string;
  wasAuthorized: boolean;
}

/**
 * Validates renderer-provided paths and, in production, replaces them with content-addressed files
 * inside the job-owned snapshot directory. The fallback without a snapshot directory exists for
 * migration diagnostics only and keeps external session locators non-durable.
 */
export async function prepareRenderMediaSnapshotForEnqueue(
  snapshot: string,
  options: AuthorizationOptions,
): Promise<string> {
  const manifest = parseManifest(snapshot);
  const capturedByIdentity = new Map<string, string>();
  if (options.snapshotDirectory) await mkdir(options.snapshotDirectory, { recursive: true });
  for (const located of collectLocators(manifest)) {
    const locator = located.locator;
    if (locator.kind === "inline") continue;
    const requestedPath = localAssetPath(locator.url);
    if (!requestedPath)
      throw new Error(
        "Render media locator must be inline or use the authorized local asset scheme",
      );
    const allowedPath = options.allowedAssets.get(renderPathKey(requestedPath));
    if (!allowedPath)
      throw new Error(`Render media asset is not authorized for this session: ${requestedPath}`);
    if (locator.kind !== "session" && locator.kind !== "bundle")
      throw new Error("Render media locator kind is invalid");
    if (locator.kind === "bundle") {
      if (typeof locator.relativePath !== "string")
        throw new Error("Render media bundle-relative path is invalid");
      // Validate renderer-provided bundle hints before replacing them with the job-owned snapshot.
      const bundleRoot = deriveBundleRoot(allowedPath, locator.relativePath);
      if (!options.snapshotDirectory) {
        await verifyLocatedFile(allowedPath, located);
        locator.root = bundleRoot;
        locator.url = localAssetUrl(allowedPath);
        continue;
      }
    }
    if (!options.snapshotDirectory) {
      await verifyLocatedFile(allowedPath, located);
      continue;
    }
    await verifyLocatedMetadata(allowedPath, located.expectedFile);
    const declaredIdentity = located.contentIdentity?.toLowerCase();
    const cryptographicIdentity = isSha256Identity(declaredIdentity) ? declaredIdentity : undefined;
    if (!cryptographicIdentity && !located.allowDerivedIdentity)
      throw new Error(
        `Render media asset has no cryptographically recoverable identity: ${allowedPath}`,
      );
    const captureKey = cryptographicIdentity
      ? `${cryptographicIdentity}:${safeExtension(allowedPath)}`
      : undefined;
    let capturedPath = captureKey ? capturedByIdentity.get(captureKey) : undefined;
    let capturedIdentity = cryptographicIdentity;
    if (!capturedPath) {
      const captured = await captureVerifiedFile(
        allowedPath,
        options.snapshotDirectory,
        declaredIdentity,
      );
      capturedPath = captured.path;
      capturedIdentity = captured.identity;
      capturedByIdentity.set(`${captured.identity}:${safeExtension(allowedPath)}`, captured.path);
    }
    if (!capturedIdentity)
      throw new Error(`Render media snapshot identity is unavailable: ${allowedPath}`);
    located.rewriteContentIdentity?.(capturedIdentity);
    locator.kind = "bundle";
    locator.root = resolve(options.snapshotDirectory);
    locator.relativePath = relative(options.snapshotDirectory, capturedPath).replaceAll("\\", "/");
    locator.url = localAssetUrl(capturedPath);
  }
  return JSON.stringify(manifest);
}

/** Reauthorizes verified bundle-relative assets and rejects expired external session grants. */
export async function authorizeRenderMediaSnapshotForLaunch(
  snapshot: string,
  options: AuthorizationOptions,
): Promise<AuthorizedRenderMediaPath[]> {
  const manifest = parseManifest(snapshot);
  const identityCache = new Map<string, Promise<string>>();
  const verifiedPaths = new Map<string, string>();
  for (const located of collectLocators(manifest)) {
    const locator = located.locator;
    if (locator.kind === "inline") continue;
    if (locator.kind === "session") {
      if (options.expectedSnapshotDirectory)
        throw new Error("Render media queued job contains an unowned session locator");
      const requestedPath = localAssetPath(locator.url);
      if (!requestedPath || !options.allowedAssets.has(renderPathKey(requestedPath)))
        throw new Error("Render media session authorization expired; relink the missing source");
      await verifyLocatedFile(requestedPath, located, identityCache);
      verifiedPaths.set(renderPathKey(requestedPath), requestedPath);
      continue;
    }
    if (
      locator.kind !== "bundle" ||
      typeof locator.root !== "string" ||
      typeof locator.relativePath !== "string"
    )
      throw new Error("Render media bundle authorization is incomplete");
    if (
      options.expectedSnapshotDirectory &&
      renderPathKey(locator.root) !== renderPathKey(options.expectedSnapshotDirectory)
    )
      throw new Error("Render media bundle root does not belong to this queued job");
    const target = containedBundleAsset(locator.root, locator.relativePath);
    await verifyLocatedFile(
      target,
      located,
      identityCache,
      options.expectedSnapshotDirectory === undefined,
    );
    locator.url = localAssetUrl(target);
    verifiedPaths.set(renderPathKey(target), target);
  }
  // Commit grants only after every locator verifies. A later invalid entry must not leave the first
  // asset reachable through the application protocol.
  return [...verifiedPaths].map(([key, path]) => {
    const wasAuthorized = options.allowedAssets.has(key);
    options.allowedAssets.set(key, path);
    return { path, wasAuthorized };
  });
}

function collectLocators(manifest: Record<string, unknown>): LocatedRenderMedia[] {
  if (manifest.version !== 1 || !Array.isArray(manifest.entries))
    throw new Error("Render media manifest version or entries are invalid");
  const result: LocatedRenderMedia[] = [];
  for (const entry of manifest.entries) {
    if (!isRecord(entry)) throw new Error("Render media manifest entry is invalid");
    if (entry.kind === "locator") {
      if (!isRecord(entry.locator)) throw new Error("Render media source locator is invalid");
      result.push({
        locator: entry.locator as RenderMediaLocatorRecord,
        ...(typeof entry.contentIdentity === "string"
          ? { contentIdentity: entry.contentIdentity }
          : {}),
      });
      continue;
    }
    if (entry.kind !== "imageSequence") continue;
    if (!isRecord(entry.selection) || !Array.isArray(entry.selection.frames))
      throw new Error("Render media image sequence is invalid");
    for (const frame of entry.selection.frames) {
      if (!isRecord(frame) || !isRecord(frame.file) || !isRecord(frame.file.locator))
        throw new Error("Render media image sequence frame is invalid");
      const file = frame.file;
      result.push({
        locator: file.locator as RenderMediaLocatorRecord,
        ...(typeof file.byteIdentity === "string" ? { contentIdentity: file.byteIdentity } : {}),
        ...(typeof file.size === "number" && typeof file.lastModified === "number"
          ? { expectedFile: { size: file.size, lastModified: file.lastModified } }
          : {}),
        allowDerivedIdentity: true,
        rewriteContentIdentity: (identity) => {
          file.byteIdentity = identity;
        },
      });
    }
  }
  return result;
}

async function captureVerifiedFile(
  sourcePath: string,
  snapshotDirectory: string,
  declaredIdentity: string | undefined,
): Promise<{ path: string; identity: string }> {
  const metadata = await stat(sourcePath).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`Render media asset is missing: ${sourcePath}`);
  const extension = safeExtension(sourcePath);
  const temporary = join(snapshotDirectory, `.${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  const computeFnv = declaredIdentity?.startsWith("fnv64:") === true;
  let fnvLeft = 0x811c9dc5;
  let fnvRight = 0x9e3779b9;
  let byteLength = 0;
  try {
    const reader = createReadStream(sourcePath);
    reader.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (computeFnv) {
        byteLength += chunk.byteLength;
        for (const byte of chunk) {
          fnvLeft = Math.imul(fnvLeft ^ byte, 0x01000193);
          fnvRight = Math.imul(fnvRight ^ byte, 0x85ebca6b);
        }
      }
    });
    await pipeline(reader, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const capturedIdentity = `sha256:${hash.digest("hex")}`;
    const capturedFnvIdentity = computeFnv
      ? `fnv64:${(fnvLeft >>> 0).toString(16).padStart(8, "0")}${(fnvRight >>> 0)
          .toString(16)
          .padStart(8, "0")}:${byteLength}`
      : undefined;
    if (
      declaredIdentity &&
      declaredIdentity !== capturedIdentity &&
      declaredIdentity !== capturedFnvIdentity
    )
      throw new Error(`Render media content identity mismatch: ${sourcePath}`);
    const destination = containedBundleAsset(
      snapshotDirectory,
      `${capturedIdentity.slice("sha256:".length)}${extension}`,
    );
    const existing = await stat(destination).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || (await sha256File(destination)) !== capturedIdentity)
        throw new Error(`Render media content-addressed snapshot is invalid: ${destination}`);
      await rm(temporary, { force: true });
    } else await rename(temporary, destination);
    // The directory is owned by the job and never exposed for editing. Read-only mode also guards
    // against accidental application writes while a long video render is consuming the snapshot.
    await chmod(destination, 0o444).catch(() => undefined);
    return { path: destination, identity: capturedIdentity };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isSha256Identity(value: string | undefined): value is string {
  return Boolean(value && /^sha256:[a-f0-9]{64}$/i.test(value));
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin";
}

function parseManifest(snapshot: string): Record<string, unknown> {
  if (!snapshot || snapshot.length > 96 * 1024 * 1024)
    throw new Error("Render media manifest size is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    throw new Error("Render media manifest must be valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Render media manifest is invalid");
  return parsed;
}

function localAssetPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16_384) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "aster-asset:" || url.hostname !== "local") return undefined;
    const encoded = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    const decoded = decodeURIComponent(encoded);
    return isAbsolute(decoded) ? resolve(decoded) : undefined;
  } catch {
    return undefined;
  }
}

function localAssetUrl(path: string): string {
  return `aster-asset://local/${encodeURIComponent(resolve(path))}`;
}

function deriveBundleRoot(assetPath: string, relativePath: string): string {
  if (!relativePath || relativePath.length > 4_096 || isAbsolute(relativePath))
    throw new Error("Render media bundle-relative path is invalid");
  const normalizedParts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (normalizedParts.length < 1 || normalizedParts.some((part) => part === "." || part === ".."))
    throw new Error("Render media bundle-relative path escapes its bundle");
  let root = resolve(assetPath);
  for (let index = 0; index < normalizedParts.length; index += 1) root = dirname(root);
  const contained = containedBundleAsset(root, relativePath);
  if (renderPathKey(contained) !== renderPathKey(assetPath))
    throw new Error("Render media bundle-relative path does not match the authorized asset");
  return root;
}

function containedBundleAsset(rootValue: string, relativePath: string): string {
  if (!isAbsolute(rootValue) || !relativePath || isAbsolute(relativePath))
    throw new Error("Render media bundle locator is invalid");
  const root = resolve(rootValue);
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation))
    throw new Error("Render media bundle-relative path escapes its trusted root");
  return target;
}

async function verifyLocatedFile(
  path: string,
  located: LocatedRenderMedia,
  identityCache = new Map<string, Promise<string>>(),
  verifyMetadata = true,
): Promise<void> {
  await verifyLocatedMetadata(path, verifyMetadata ? located.expectedFile : undefined);
  if (!located.contentIdentity) return;
  if (!isSha256Identity(located.contentIdentity))
    throw new Error(`Render media bundle identity is not cryptographically recoverable: ${path}`);
  let digest = identityCache.get(path);
  if (!digest) {
    digest = sha256File(path);
    identityCache.set(path, digest);
  }
  if ((await digest).toLowerCase() !== located.contentIdentity.toLowerCase())
    throw new Error(`Render media content identity mismatch: ${path}`);
}

async function verifyLocatedMetadata(
  path: string,
  expectedFile: LocatedRenderMedia["expectedFile"],
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`Render media asset is missing: ${path}`);
  }
  if (!metadata.isFile()) throw new Error(`Render media asset is not a file: ${path}`);
  if (expectedFile) {
    if (metadata.size !== expectedFile.size)
      throw new Error(`Render media frame identity mismatch: ${path}`);
    // File pickers expose integer epoch milliseconds. Allow sub-millisecond filesystem rounding.
    if (Math.abs(metadata.mtimeMs - expectedFile.lastModified) >= 1)
      throw new Error(`Render media frame identity mismatch: ${path}`);
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
