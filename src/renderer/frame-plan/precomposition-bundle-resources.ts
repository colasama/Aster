import { requirePlan } from "./canonical";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { contentResourceHashSync, validateResourceMessage } from "./resources";
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
    if (!this.entries.has(message.hash)) {
      requirePlan(
        this.entries.size < 65536 && this.#bytes + input.bytes.length <= 67108864,
        "limit_exceeded",
        "Surface bundle resource budget exceeded",
      );
      this.entries.set(message.hash, {
        message: structuredClone(message),
        bytes: new Uint8Array(input.bytes),
      });
      this.#bytes += input.bytes.length;
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
    return this.add({
      message: { type: "put_resource", ...content, hash: contentResourceHashSync(content, bytes) },
      bytes,
    });
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
