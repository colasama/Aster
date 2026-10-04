import { FramePlanError } from "../frame-plan/types";
import { type MediaResource, retainMediaResources } from "./media-resource";

export interface MediaBindingEntry {
  instanceId: string;
  resource?: MediaResource;
  binding?: GPUBindGroup;
}

/** Runtime GPU adapter; handles stay outside serializable frame-plan metadata. */
export class MediaBindingLease {
  readonly #entries: ReadonlyMap<
    string,
    MediaBindingEntry & { source?: string; uploadedTime?: number }
  >;
  readonly #releaseOwners: () => void;
  #released = false;

  constructor(entries: readonly MediaBindingEntry[]) {
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
    }
    this.#releaseOwners = retainMediaResources(
      entries.flatMap((entry) => (entry.resource ? [entry.resource] : [])),
    );
    this.#entries = unique;
  }

  get hasOwners(): boolean {
    return [...this.#entries.values()].some((entry) => entry.resource !== undefined);
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
