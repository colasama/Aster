import { copyWireValue, requirePlan } from "./canonical";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { contentResourceHash, contentResourceHashSync, validateResourceMessage } from "./resources";
import type { FramePlanSliceData, FramePlanSliceV1, PutResource } from "./types";

export interface BundleResource {
  message: PutResource;
  bytes: Uint8Array;
}

/** Owns validated payloads. Scene decoding can only follow declared, content-verified references. */
export class PrecompositionBundleResources {
  readonly entries = new Map<string, BundleResource>();
  readonly used = new Set<string>();
  #bytes = 0;
  readonly #pending: Promise<string>[] = [];
  #pendingBytes = 0;
  #activeHashes = 0;
  readonly #hashWaiters = new Set<() => void>();

  /** Own encoded bytes before yielding to bounded native digest dispatch. */
  addRequiredPlanAsync(
    plan: FramePlanSliceData,
    contract: FramePlanSliceV1["contract_level"],
  ): Promise<string> {
    const pending = this.#hashRequiredPlan(plan, contract);
    this.#pending.push(pending);
    void pending.catch(() => undefined);
    return pending;
  }

  async settle(): Promise<void> {
    const results = await Promise.allSettled(this.#pending);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  async #hashRequiredPlan(
    plan: FramePlanSliceData,
    contract: FramePlanSliceV1["contract_level"],
  ): Promise<string> {
    requirePlan(
      plan.metadata.contract_level === contract,
      "invalid_precomposition",
      "Surface plan contract differs",
    );
    const bytes = encodeFramePlan(plan.metadata, plan.blobs);
    const dependencies = [...plan.metadata.resources];
    const content = {
      kind: "buffer" as const,
      descriptor: {
        element_type: "u8" as const,
        element_count: bytes.length,
        byte_length: bytes.length,
      },
    };
    const accelerated =
      this.#hashWaiters.size < 65536 && this.#pendingBytes + bytes.length <= 67108864;
    if (accelerated) {
      this.#pendingBytes += bytes.length;
      if (this.#activeHashes >= 32)
        await new Promise<void>((resume) => this.#hashWaiters.add(resume));
      else this.#activeHashes += 1;
    }
    try {
      const hash = accelerated
        ? await contentResourceHash(content, bytes)
        : contentResourceHashSync(content, bytes);
      this.#store({ type: "put_resource", ...content, hash }, bytes);
      this.resolve(hash);
      for (const dependency of dependencies) this.resolve(dependency);
      return hash;
    } finally {
      if (accelerated) {
        this.#pendingBytes -= bytes.length;
        const resume = this.#hashWaiters.values().next().value;
        if (resume) {
          this.#hashWaiters.delete(resume);
          resume();
        } else this.#activeHashes -= 1;
      }
    }
  }

  add(input: BundleResource): string {
    const message = validateResourceMessage(input.message);
    requirePlan(
      message.type === "put_resource",
      "invalid_resource",
      "Bundle cannot contain eviction",
    );
    requirePlan(
      contentResourceHashSync(message, input.bytes) === message.hash,
      "hash_mismatch",
      "Surface bundle resource hash mismatch",
    );
    return this.#store(message, input.bytes);
  }
  /** Own the input before awaiting accelerated hashing; callers may reuse their transport buffers. */
  async addAsync(input: BundleResource): Promise<string> {
    const message = copyWireValue(validateResourceMessage(input.message));
    requirePlan(
      message.type === "put_resource",
      "invalid_resource",
      "Bundle cannot contain eviction",
    );
    const bytes = new Uint8Array(input.bytes);
    requirePlan(
      (await contentResourceHash(message, bytes)) === message.hash,
      "hash_mismatch",
      "Surface bundle resource hash mismatch",
    );
    return this.#store(message, bytes);
  }
  #store(message: PutResource, bytes: Uint8Array): string {
    if (!this.entries.has(message.hash)) {
      requirePlan(
        this.entries.size < 65536 && this.#bytes + bytes.length <= 67108864,
        "limit_exceeded",
        "Surface bundle resource budget exceeded",
      );
      this.entries.set(message.hash, {
        message: copyWireValue(message),
        bytes: new Uint8Array(bytes),
      });
      this.#bytes += bytes.length;
    }
    return message.hash;
  }
  addPlan(plan: FramePlanSliceData): string {
    const bytes = encodeFramePlan(plan.metadata, plan.blobs);
    const content = {
      kind: "buffer" as const,
      descriptor: {
        element_type: "u8" as const,
        element_count: bytes.length,
        byte_length: bytes.length,
      },
    };
    // Encoding owns and validates these bytes; do not rehash the freshly constructed resource.
    return this.#store(
      { type: "put_resource", ...content, hash: contentResourceHashSync(content, bytes) },
      bytes,
    );
  }
  /** Encoding validates the producer's plan; register its dependencies without decoding it again. */
  addRequiredPlan(plan: FramePlanSliceData, contract: FramePlanSliceV1["contract_level"]): string {
    requirePlan(
      plan.metadata.contract_level === contract,
      "invalid_precomposition",
      "Surface plan contract differs",
    );
    const hash = this.addPlan(plan);
    this.resolve(hash);
    for (const dependency of plan.metadata.resources) this.resolve(dependency);
    return hash;
  }
  resolve(hash: string): BundleResource {
    const resource = this.entries.get(hash);
    requirePlan(resource, "missing_resource", "Surface bundle dependency is absent");
    this.used.add(hash);
    if (resource.message.kind === "media_frame") {
      const sourceHash = resource.message.descriptor.source;
      const source = this.entries.get(sourceHash);
      requirePlan(source, "missing_resource", "Surface media source is absent");
      requirePlan(
        source.message.kind === "media_source",
        "invalid_resource",
        "Surface media source has wrong kind",
      );
      this.used.add(sourceHash);
    }
    return resource;
  }
  plan(hash: string, contract: FramePlanSliceV1["contract_level"]): FramePlanSliceData {
    const resource = this.resolve(hash);
    requirePlan(
      resource.message.kind === "buffer" && resource.message.descriptor.element_type === "u8",
      "invalid_resource",
      "Surface plan requires a byte buffer",
    );
    const plan = decodeFramePlan(resource.bytes);
    requirePlan(
      plan.metadata.contract_level === contract,
      "invalid_precomposition",
      "Surface plan contract differs",
    );
    for (const dependency of plan.metadata.resources) this.resolve(dependency);
    return plan;
  }
}
