import { FramePlanError, type PutResource } from "../frame-plan/types";
import { mediaFrameMessages } from "./media-frame-identity";
import { type MediaResource, retainMediaResources } from "./media-resource";

export interface MediaBindingEntry {
  instanceId: string;
  resource?: MediaResource;
  binding?: GPUBindGroup;
  requestedTime?: number;
}

/** Runtime GPU adapter; handles stay outside serializable frame-plan metadata. */
export class MediaBindingLease {
  readonly #entries: ReadonlyMap<
    string,
    MediaBindingEntry & { source?: string; uploadedTime?: number }
  >;
  readonly #releaseOwners: () => void;
  #released = false;
  readonly #hashes = new Map<string, string | null>();
  readonly #messages = new Map<string, PutResource>();
  readonly #ownersByHash = new Map<string, string[]>();

  constructor(entries: readonly MediaBindingEntry[], scope = "local-preview") {
    const unique = new Map<
      string,
      MediaBindingEntry & { source?: string; uploadedTime?: number }
    >();
    for (const entry of entries) {
      if (unique.has(entry.instanceId))
        throw new FramePlanError("resource_conflict", "Duplicate media binding instance");
      unique.set(entry.instanceId, {
        ...entry,
        source: entry.resource?.source,
        uploadedTime: entry.resource?.lastUploadedTime,
      });
      if (!entry.binding) this.#hashes.set(entry.instanceId, null);
      else {
        if (!entry.resource)
          throw new FramePlanError("missing_resource", "Bound media has no retained owner");
        const messages = mediaFrameMessages(entry.resource, scope, entry.requestedTime);
        for (const message of messages) this.#messages.set(message.hash, message);
        const hash = messages[1].hash;
        this.#hashes.set(entry.instanceId, hash);
        this.#ownersByHash.set(hash, [...(this.#ownersByHash.get(hash) ?? []), entry.instanceId]);
      }
    }
    this.#releaseOwners = retainMediaResources(
      entries.flatMap((entry) => (entry.resource ? [entry.resource] : [])),
    );
    this.#entries = unique;
  }

  get hasOwners(): boolean {
    return [...this.#entries.values()].some((entry) => entry.resource !== undefined);
  }

  get resourceMessages(): PutResource[] {
    return structuredClone([...this.#messages.values()]);
  }

  hashFor(instanceId: string): string | null {
    if (this.#released || !this.#hashes.has(instanceId))
      throw new FramePlanError("missing_resource", "Media reference is absent or released");
    return this.#hashes.get(instanceId) ?? null;
  }

  bindingForHash(hash: string | null | undefined): GPUBindGroup | undefined {
    if (this.#released)
      throw new FramePlanError("missing_resource", "Media binding lease was released");
    if (hash === null) return undefined;
    const owners = hash === undefined ? undefined : this.#ownersByHash.get(hash);
    if (!owners)
      throw new FramePlanError("missing_resource", "Media hash is absent from the frame");
    const bindings = owners.map((owner) => this.bindingFor(owner));
    return bindings[0];
  }

  bindingFor(instanceId: string): GPUBindGroup | undefined {
    if (this.#released)
      throw new FramePlanError("missing_resource", "Media binding lease was released");
    const entry = this.#entries.get(instanceId);
    if (!entry)
      throw new FramePlanError(
        "missing_resource",
        "Media binding is absent from the submitted frame",
      );
    if (
      entry.resource &&
      (entry.resource.source !== entry.source ||
        !Object.is(entry.resource.lastUploadedTime, entry.uploadedTime))
    )
      throw new FramePlanError(
        "resource_generation_mismatch",
        "Media changed after frame binding acquisition",
      );
    return entry.binding;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#releaseOwners();
  }
}
