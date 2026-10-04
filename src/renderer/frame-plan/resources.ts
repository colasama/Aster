import { canonicalJson, hash, integer, object, requirePlan } from "./canonical";
import type { BufferResourceDescriptor, ResourceMessage } from "./types";
import { validateBufferDescriptor } from "./validation";

export async function resourceHash(
  descriptor: BufferResourceDescriptor,
  bytes: Uint8Array,
): Promise<string> {
  validateBufferDescriptor(descriptor);
  requirePlan(
    bytes.byteLength === descriptor.byte_length,
    "element_count_mismatch",
    "Resource byte length mismatch",
  );
  const prefix = new TextEncoder().encode("ASTER_RESOURCE_V1\0");
  const json = new TextEncoder().encode(canonicalJson({ kind: "buffer", descriptor }));
  const input = new Uint8Array(prefix.length + 4 + json.length + bytes.length);
  input.set(prefix);
  new DataView(input.buffer).setUint32(prefix.length, json.length, true);
  input.set(json, prefix.length + 4);
  input.set(bytes, prefix.length + 4 + json.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
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
    requirePlan(message.kind === "buffer", "unknown_variant", "Unsupported resource kind");
    validateBufferDescriptor(message.descriptor);
    return message as unknown as ResourceMessage;
  }
  requirePlan(type === "evict_resource", "unknown_variant", "Unsupported resource operation");
  const message = object(value, ["type", "hash"]);
  hash(message.hash);
  return message as unknown as ResourceMessage;
}

interface StoredResource {
  descriptor: BufferResourceDescriptor;
  bytes: Uint8Array;
  pins: number;
}

export interface ResourceLease {
  readonly hashes: readonly string[];
  release(): void;
}

/** Bounded CPU transport storage. It does not claim GPU allocation or sidecar transport. */
export class FrameResourceRegistry {
  readonly #resources = new Map<string, StoredResource>();
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
      this.#used -= resource.bytes.byteLength;
      return;
    }
    requirePlan(bytes !== undefined, "missing_resource", "PutResource requires binary bytes");
    requirePlan(
      bytes.byteLength === message.descriptor.byte_length,
      "element_count_mismatch",
      "Resource byte length mismatch",
    );
    requirePlan(
      bytes.byteLength <= this.#budget &&
        (this.#resources.has(message.hash) ||
          (this.#resources.size < this.#countLimit &&
            bytes.byteLength <= this.#budget - this.#used)),
      "resource_budget_exceeded",
      "Resource exceeds admission budget before copying",
    );
    // Snapshot input before awaiting hashing so concurrent caller mutation cannot change admission.
    const owned = new Uint8Array(bytes);
    const descriptor = { ...message.descriptor };
    const identity = message.hash;
    requirePlan(
      (await resourceHash(descriptor, owned)) === identity,
      "hash_mismatch",
      "Resource content hash mismatch",
    );
    if (this.#resources.has(identity)) return;
    requirePlan(
      this.#resources.size < this.#countLimit && owned.byteLength <= this.#budget - this.#used,
      "resource_budget_exceeded",
      `Resource budget exceeded: used=${this.#used}, requested=${owned.byteLength}, budget=${this.#budget}`,
    );
    this.#resources.set(identity, { descriptor, bytes: owned, pins: 0 });
    this.#used += owned.byteLength;
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
