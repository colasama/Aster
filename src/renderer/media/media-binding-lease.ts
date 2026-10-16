import { copyWireValue, requirePlan } from "../frame-plan/canonical";
import type { PutResource } from "../frame-plan/types";
import { mediaFrameMessages } from "./media-frame-identity";
import { type MediaGpuLease, MediaGpuRegistry } from "./media-gpu-registry";
import type { MediaResource } from "./media-resource";

export interface MediaBindingEntry {
  instanceId: string;
  resource?: MediaResource;
  binding?: GPUBindGroup;
  requestedTime?: number;
}

/** Per-frame references and a lease on persistent content-addressed GPU registrations. */
export class MediaBindingLease {
  readonly #hashes = new Map<string, string | null>();
  readonly #messages = new Map<string, PutResource>();
  readonly #lease: MediaGpuLease;
  readonly #registry: MediaGpuRegistry;
  readonly #ownsRegistry: boolean;
  #released = false;

  constructor(
    entries: readonly MediaBindingEntry[],
    scope = "local-preview",
    registry?: MediaGpuRegistry,
  ) {
    this.#ownsRegistry = registry === undefined;
    this.#registry = registry ?? new MediaGpuRegistry();
    this.#registry.prune();
    for (const entry of entries) {
      requirePlan(
        !this.#hashes.has(entry.instanceId),
        "resource_conflict",
        "Duplicate media binding instance",
      );
      if (!entry.binding) this.#hashes.set(entry.instanceId, null);
      else {
        requirePlan(entry.resource, "missing_resource", "Bound media has no retained owner");
        const messages = mediaFrameMessages(entry.resource, scope, entry.requestedTime);
        this.#registry.apply(messages[0]);
        this.#registry.apply(messages[1], entry.resource, entry.binding);
        for (const message of messages) this.#messages.set(message.hash, message);
        this.#hashes.set(entry.instanceId, messages[1].hash);
      }
    }
    this.#lease = this.#registry.pin([
      ...new Set([...this.#hashes.values()].filter((hash): hash is string => hash !== null)),
    ]);
  }

  get hasOwners(): boolean {
    return this.#messages.size > 0;
  }
  get resourceMessages(): PutResource[] {
    return [...this.#messages.values()].map(copyWireValue);
  }

  hashFor(instanceId: string): string | null {
    requirePlan(
      !this.#released && this.#hashes.has(instanceId),
      "missing_resource",
      "Media reference is absent or released",
    );
    return this.#hashes.get(instanceId) ?? null;
  }

  bindingForHash(hash: string | null | undefined): GPUBindGroup | undefined {
    requirePlan(!this.#released, "missing_resource", "Media binding lease was released");
    if (hash === null) return undefined;
    requirePlan(hash !== undefined, "missing_resource", "Media hash is absent from the frame");
    return this.#lease.bindingForHash(hash);
  }

  textureForHash(hash: string): GPUTexture {
    requirePlan(!this.#released, "missing_resource", "Media binding lease was released");
    return this.#lease.textureForHash(hash);
  }

  /** Independent ownership for readback that outlives the producer's submission lease. */
  retainForCapture(hashes: readonly string[]): MediaGpuLease {
    requirePlan(!this.#released, "missing_resource", "Media binding lease was released");
    for (const hash of hashes) this.#lease.textureForHash(hash);
    return this.#registry.pin(hashes);
  }

  bindingFor(instanceId: string): GPUBindGroup | undefined {
    return this.bindingForHash(this.hashFor(instanceId));
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#lease.release();
    if (this.#ownsRegistry) this.#registry.destroy();
  }
}
