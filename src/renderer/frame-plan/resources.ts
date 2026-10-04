import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, hash, integer, object, requirePlan } from "./canonical";
import { validateMediaFrame, validateMediaSource } from "./media-descriptors";
import { validateRasterPixels } from "./raster-pixels";
import type { BufferResourceDescriptor, ResourceContent, ResourceMessage } from "./types";
import { validateBufferDescriptor } from "./validation";

export async function resourceHash(
  descriptor: BufferResourceDescriptor,
  bytes: Uint8Array,
): Promise<string> {
  return contentResourceHash({ kind: "buffer", descriptor }, bytes);
}

export function validateResourceContent(content: ResourceContent, bytes: Uint8Array): void {
  if (content.kind === "buffer") {
    validateBufferDescriptor(content.descriptor);
    requirePlan(
      bytes.byteLength === content.descriptor.byte_length,
      "element_count_mismatch",
      "Resource byte length mismatch",
    );
    return;
  }
  if (content.kind === "raster_pixels") {
    const raster = validateRasterPixels(content.descriptor);
    requirePlan(
      bytes.byteLength === raster.width * raster.height * 4,
      "element_count_mismatch",
      "Raster pixel byte length mismatch",
    );
    return;
  }
  if (content.kind === "media_source") validateMediaSource(content.descriptor);
  else if (content.kind === "media_frame") validateMediaFrame(content.descriptor);
  else requirePlan(false, "unknown_variant", "Unsupported resource kind");
  requirePlan(
    bytes.byteLength === 0,
    "element_count_mismatch",
    "Media descriptors must not carry pixel bytes",
  );
}

/** Same domain-separated identity for buffers and declarative media resources. */
export async function contentResourceHash(
  content: ResourceContent,
  bytes: Uint8Array = new Uint8Array(),
): Promise<string> {
  const input = resourceHashInput(content, bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Synchronous small-descriptor hashing keeps frame preparation free of asynchronous stalls. */
export function contentResourceHashSync(content: ResourceContent): string {
  return Array.from(sha256(resourceHashInput(content, new Uint8Array())), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function resourceHashInput(content: ResourceContent, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  validateResourceContent(content, bytes);
  const prefix = new TextEncoder().encode("ASTER_RESOURCE_V1\0");
  const json = new TextEncoder().encode(
    canonicalJson({ kind: content.kind, descriptor: content.descriptor }),
  );
  requirePlan(
    json.length <= 0xffff_ffff,
    "limit_exceeded",
    "Resource descriptor exceeds wire length",
  );
  const input = new Uint8Array(prefix.length + 4 + json.length + bytes.length);
  input.set(prefix);
  new DataView(input.buffer).setUint32(prefix.length, json.length, true);
  input.set(json, prefix.length + 4);
  input.set(bytes, prefix.length + 4 + json.length);
  return input;
}

export function validateResourceMessage(value: unknown): ResourceMessage {
  requirePlan(
    value !== null && typeof value === "object",
    "invalid_json",
    "Invalid resource message",
  );
  const type = (value as Record<string, unknown>).type;
  if (type === "put_resource") {
    const message = object(value, ["type", "hash", "kind", "descriptor"]);
    hash(message.hash);
    if (message.kind === "buffer") validateBufferDescriptor(message.descriptor);
    else if (message.kind === "media_source") validateMediaSource(message.descriptor);
    else if (message.kind === "media_frame") validateMediaFrame(message.descriptor);
    else if (message.kind === "raster_pixels") validateRasterPixels(message.descriptor);
    else requirePlan(false, "unknown_variant", "Unsupported resource kind");
    return message as unknown as ResourceMessage;
  }
  requirePlan(type === "evict_resource", "unknown_variant", "Unsupported resource operation");
  const message = object(value, ["type", "hash"]);
  hash(message.hash);
  return message as unknown as ResourceMessage;
}

interface StoredResource {
  content: ResourceContent;
  bytes: Uint8Array;
  accountedBytes: number;
  pins: number;
}

export interface ResourceLease {
  readonly hashes: readonly string[];
  release(): void;
}

/** Bounded CPU transport storage. It does not claim GPU allocation or sidecar transport. */
export class FrameResourceRegistry {
  readonly #resources = new Map<string, StoredResource>();
  readonly #rasterPixels = new Map<string, string>();
  #used = 0;
  readonly #budget: number;
  readonly #countLimit: number;
  readonly #leaseLimit: number;
  #activeLeases = 0;

  constructor(options: { budget_bytes: number; max_resources: number; max_leases?: number }) {
    this.#budget = integer(options.budget_bytes);
    this.#countLimit = integer(options.max_resources, 1, 0xffff_ffff);
    this.#leaseLimit = integer(options.max_leases ?? 4096, 1, 0xffff_ffff);
  }

  get usedBytes(): number {
    return this.#used;
  }
  get size(): number {
    return this.#resources.size;
  }

  async apply(input: ResourceMessage, bytes?: Uint8Array): Promise<void> {
    const message = validateResourceMessage(input);
    if (message.type === "evict_resource") {
      requirePlan(bytes === undefined, "invalid_json", "EvictResource must not carry bytes");
      const resource = this.#resources.get(message.hash);
      requirePlan(resource, "missing_resource", `Missing resource ${message.hash}`);
      requirePlan(resource.pins === 0, "resource_in_use", "Cannot evict a pinned resource");
      this.#resources.delete(message.hash);
      if (resource.content.kind === "raster_pixels")
        this.#rasterPixels.delete(resource.content.descriptor.frame);
      this.#used -= resource.accountedBytes;
      const dependency =
        resource.content.kind === "media_frame"
          ? resource.content.descriptor.source
          : resource.content.kind === "raster_pixels"
            ? resource.content.descriptor.frame
            : undefined;
      if (dependency) {
        const source = this.#resources.get(dependency);
        requirePlan(source, "missing_resource", "Media source was evicted while referenced");
        source.pins -= 1;
      }
      return;
    }
    requirePlan(
      (message.kind !== "buffer" && message.kind !== "raster_pixels") || bytes !== undefined,
      "missing_resource",
      "Pixel and buffer PutResource require binary bytes",
    );
    const inputBytes = bytes ?? new Uint8Array();
    validateResourceContent(message, inputBytes);
    const accountedBytes =
      message.kind === "buffer" || message.kind === "raster_pixels"
        ? inputBytes.byteLength
        : new TextEncoder().encode(canonicalJson(message.descriptor)).length;
    requirePlan(
      accountedBytes <= this.#budget &&
        (this.#resources.has(message.hash) ||
          (this.#resources.size < this.#countLimit && accountedBytes <= this.#budget - this.#used)),
      "resource_budget_exceeded",
      "Resource exceeds admission budget before copying",
    );
    // Snapshot input before awaiting hashing so concurrent caller mutation cannot change admission.
    const owned = new Uint8Array(inputBytes);
    const content: ResourceContent = structuredClone({
      kind: message.kind,
      descriptor: message.descriptor,
    } as ResourceContent);
    const identity = message.hash;
    requirePlan(
      (await contentResourceHash(content, owned)) === identity,
      "hash_mismatch",
      "Resource content hash mismatch",
    );
    if (this.#resources.has(identity)) return;
    requirePlan(
      this.#resources.size < this.#countLimit && accountedBytes <= this.#budget - this.#used,
      "resource_budget_exceeded",
      `Resource budget exceeded: used=${this.#used}, requested=${accountedBytes}, budget=${this.#budget}`,
    );
    if (content.kind === "media_frame") {
      const source = this.#resources.get(content.descriptor.source);
      requirePlan(source, "missing_resource", "Media source must be admitted before its frame");
      requirePlan(
        source.content.kind === "media_source" &&
          source.content.descriptor.media_kind === content.descriptor.sample.kind,
        "resource_conflict",
        "Media frame/source kind mismatch",
      );
      source.pins += 1;
    }
    if (content.kind === "raster_pixels") {
      requirePlan(
        !this.#rasterPixels.has(content.descriptor.frame),
        "resource_conflict",
        "A raster frame already has different pixel content",
      );
      const frame = this.#resources.get(content.descriptor.frame);
      requirePlan(frame, "missing_resource", "Raster frame must precede pixel admission");
      requirePlan(
        frame.content.kind === "media_frame" &&
          frame.content.descriptor.sample.kind === "raster" &&
          frame.content.descriptor.width === content.descriptor.width &&
          frame.content.descriptor.height === content.descriptor.height &&
          frame.content.descriptor.format === content.descriptor.format,
        "resource_conflict",
        "Raster pixel/frame mismatch",
      );
      frame.pins += 1;
      this.#rasterPixels.set(content.descriptor.frame, identity);
    }
    this.#resources.set(identity, { content, bytes: owned, accountedBytes, pins: 0 });
    this.#used += accountedBytes;
  }

  /** Return owned transport data; consumers cannot mutate registry identity through this view. */
  resolve(identity: string): { content: ResourceContent; bytes: Uint8Array } {
    hash(identity);
    const entry = this.#resources.get(identity);
    requirePlan(entry, "missing_resource", `Missing resource ${identity}`);
    return { content: structuredClone(entry.content), bytes: new Uint8Array(entry.bytes) };
  }

  /** Resolve every reference before pinning any entry. The lease closes over its owning registry. */
  pin(hashes: readonly string[]): ResourceLease {
    requirePlan(
      hashes.length <= this.#countLimit,
      "limit_exceeded",
      "Too many resource references",
    );
    requirePlan(
      this.#activeLeases < this.#leaseLimit,
      "limit_exceeded",
      "Active resource lease limit reached",
    );
    requirePlan(
      new Set(hashes).size === hashes.length,
      "resource_conflict",
      "Duplicate resource reference",
    );
    const entries = hashes.map((identity) => {
      hash(identity);
      const entry = this.#resources.get(identity);
      requirePlan(entry, "missing_resource", `Missing resource ${identity}`);
      return entry;
    });
    for (const entry of entries) entry.pins += 1;
    this.#activeLeases += 1;
    let released = false;
    return {
      hashes: Object.freeze([...hashes]),
      release: () => {
        if (released) return;
        released = true;
        for (const entry of entries) entry.pins -= 1;
        this.#activeLeases -= 1;
      },
    };
  }
}
