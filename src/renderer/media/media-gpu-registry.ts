import { FALLBACK_GPU_MEMORY_MB } from "../../core/rendering/gpu-memory-policy";
import {
  canonicalJson,
  copyWireValue,
  integer,
  requirePlan,
  sameCanonicalValue,
} from "../frame-plan/canonical";
import { contentResourceHashSync, validateResourceMessage } from "../frame-plan/resources";
import { frameTimeToNumber } from "../frame-plan/time";
import type { PutResource, ResourceMessage } from "../frame-plan/types";
import { mediaFrameMessages } from "./media-frame-identity";
import { type MediaResource, mediaResourceRetired, retainMediaResources } from "./media-resource";

interface BindingVersion {
  owner: MediaResource;
  binding: GPUBindGroup;
  source: string;
  uploadedTime?: number;
  pins: number;
}

interface RegisteredMedia {
  message: PutResource;
  descriptorBytes: number;
  dependencies: number;
  pins: number;
  versions: Map<MediaResource, BindingVersion>;
}

export interface MediaGpuLease {
  bindingForHash(hash: string): GPUBindGroup;
  textureForHash(hash: string): GPUTexture;
  release(): void;
}

/** Descriptor storage and GPU bindings are separate; a hash never serializes a native handle. */
export class MediaGpuRegistry {
  readonly #entries = new Map<string, RegisteredMedia>();
  readonly #descriptorBudget: number;
  readonly #gpuBudget: number;
  readonly #countLimit: number;
  readonly #leaseLimit: number;
  #descriptorBytes = 0;
  #versions = 0;
  #leases = 0;
  #destroyed = false;

  constructor(
    options: {
      descriptorBytes?: number;
      gpuBytes?: number;
      maxResources?: number;
      maxLeases?: number;
    } = {},
  ) {
    this.#descriptorBudget = integer(options.descriptorBytes ?? 16 * 1024 * 1024);
    this.#gpuBudget = integer(options.gpuBytes ?? FALLBACK_GPU_MEMORY_MB * 1024 * 1024);
    this.#countLimit = integer(options.maxResources ?? 65536, 1);
    this.#leaseLimit = integer(options.maxLeases ?? 4096, 1);
  }

  get residentOwners(): ReadonlySet<MediaResource> {
    const owners = new Set<MediaResource>();
    for (const entry of this.#entries.values())
      for (const version of entry.versions.values()) {
        if (!mediaResourceRetired(version.owner) || version.pins > 0) owners.add(version.owner);
      }
    return owners;
  }

  get statistics() {
    let gpuBytes = 0;
    for (const owner of this.residentOwners) gpuBytes += this.#ownerBytes(owner);
    return { resources: this.#entries.size, descriptorBytes: this.#descriptorBytes, gpuBytes };
  }

  apply(input: ResourceMessage, owner?: MediaResource, binding?: GPUBindGroup): void {
    const previous = input?.type === "put_resource" ? this.#entries.get(input.hash) : undefined;
    const unchanged = previous && sameCanonicalValue(input, previous.message);
    const message = unchanged ? previous.message : validateResourceMessage(input);
    if (message.type === "evict_resource") {
      requirePlan(
        owner === undefined && binding === undefined,
        "invalid_resource",
        "Eviction carries no GPU binding",
      );
      this.#evict(message.hash);
      return;
    }
    requirePlan(!this.#destroyed, "missing_resource", "GPU registry is destroyed");
    requirePlan(
      message.kind === "media_source" || message.kind === "media_frame",
      "invalid_resource",
      "GPU media registry accepts media descriptors only",
    );
    requirePlan(
      unchanged || contentResourceHashSync(message) === message.hash,
      "hash_mismatch",
      "GPU resource descriptor hash mismatch",
    );
    const existing = this.#entries.get(message.hash);
    requirePlan(!existing || unchanged, "resource_conflict", "GPU descriptor identity conflict");
    const bytes =
      existing?.descriptorBytes ??
      new TextEncoder().encode(canonicalJson(message.descriptor)).length;
    requirePlan(
      existing ||
        (this.#entries.size < this.#countLimit &&
          bytes <= this.#descriptorBudget - this.#descriptorBytes),
      "resource_budget_exceeded",
      "GPU media descriptor budget exceeded",
    );
    let version: BindingVersion | undefined;
    let source: RegisteredMedia | undefined;
    if (message.kind === "media_frame") {
      requirePlan(
        owner && binding && owner.bindGroup === binding && !mediaResourceRetired(owner),
        "missing_resource",
        "Frame binding owner is missing or retired",
      );
      source = this.#entries.get(message.descriptor.source);
      requirePlan(
        source?.message.kind === "media_source",
        "missing_resource",
        "Frame source is not registered",
      );
      const requestedTime =
        message.descriptor.sample.kind === "video"
          ? frameTimeToNumber(message.descriptor.sample.requested_time)
          : undefined;
      const expected = mediaFrameMessages(
        owner,
        source.message.descriptor.authorization_scope,
        requestedTime,
      );
      requirePlan(
        expected[0].hash === message.descriptor.source && expected[1].hash === message.hash,
        "resource_generation_mismatch",
        "GPU binding does not match the supplied media frame",
      );
      const owners = this.residentOwners;
      requirePlan(
        owners.has(owner) || this.statistics.gpuBytes + this.#ownerBytes(owner) <= this.#gpuBudget,
        "resource_budget_exceeded",
        "Registered media GPU budget exceeded",
      );
      version = existing?.versions.get(owner);
      requirePlan(
        !version || this.#current(version),
        "resource_generation_mismatch",
        "Existing GPU binding generation is obsolete",
      );
      requirePlan(
        version || this.#versions < this.#countLimit,
        "resource_budget_exceeded",
        "GPU media binding count exceeded",
      );
      version ??= {
        owner,
        binding,
        source: owner.bindingGeneration ?? owner.source,
        uploadedTime: owner.lastUploadedTime,
        pins: 0,
      };
    } else
      requirePlan(
        owner === undefined && binding === undefined,
        "invalid_resource",
        "Source descriptors carry no GPU binding",
      );
    const entry = existing ?? {
      message: copyWireValue(message),
      descriptorBytes: bytes,
      dependencies: 0,
      pins: 0,
      versions: new Map<MediaResource, BindingVersion>(),
    };
    if (!existing) {
      this.#entries.set(message.hash, entry);
      this.#descriptorBytes += bytes;
      if (source) source.dependencies += 1;
    }
    if (version && !entry.versions.has(version.owner)) {
      entry.versions.set(version.owner, version);
      this.#versions += 1;
    }
  }

  pin(hashes: readonly string[]): MediaGpuLease {
    requirePlan(
      !this.#destroyed &&
        hashes.length <= this.#countLimit &&
        new Set(hashes).size === hashes.length,
      "invalid_resource",
      "Invalid GPU media lease request",
    );
    requirePlan(
      this.#leases < this.#leaseLimit,
      "resource_budget_exceeded",
      "GPU media lease count exceeded",
    );
    const selected = hashes.map((hash) => {
      const entry = this.#entries.get(hash);
      requirePlan(
        entry?.message.kind === "media_frame",
        "missing_resource",
        "GPU media frame hash is absent",
      );
      const version = [...entry.versions.values()].find(
        (value) => !mediaResourceRetired(value.owner) && this.#current(value),
      );
      requirePlan(version, "resource_generation_mismatch", "No current GPU binding for media hash");
      return { hash, entry, version };
    });
    const releaseOwners = retainMediaResources(selected.map(({ version }) => version.owner));
    const byHash = new Map(selected.map((frame) => [frame.hash, frame]));
    this.#leases += 1;
    for (const { entry, version } of selected) {
      entry.pins += 1;
      version.pins += 1;
    }
    let released = false;
    const selectedVersion = (hash: string) => {
      requirePlan(!released, "missing_resource", "GPU media lease was released");
      const selectedFrame = byHash.get(hash);
      requirePlan(selectedFrame, "missing_resource", "GPU media hash is absent from the lease");
      requirePlan(
        this.#current(selectedFrame.version),
        "resource_generation_mismatch",
        "Media changed after acquisition",
      );
      return selectedFrame.version;
    };
    return {
      bindingForHash: (hash) => selectedVersion(hash).binding,
      textureForHash: (hash) => {
        const owner = selectedVersion(hash).owner;
        requirePlan(
          !owner.nativeVideoPlan,
          "missing_resource",
          "Native video plans contain no browser pixels",
        );
        const texture = owner.texture;
        requirePlan(texture, "missing_resource", "Pinned media texture is absent");
        return texture;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#leases -= 1;
        for (const { entry, version } of selected) {
          entry.pins -= 1;
          version.pins -= 1;
        }
        releaseOwners();
        this.prune();
      },
    };
  }

  /** Drops obsolete generations only after their submitted owners finish. */
  prune(): void {
    for (const [hash, entry] of this.#entries) {
      if (entry.message.kind !== "media_frame") continue;
      for (const [owner, version] of entry.versions) {
        if (
          version.pins === 0 &&
          (this.#destroyed || mediaResourceRetired(owner) || !this.#current(version))
        ) {
          entry.versions.delete(owner);
          this.#versions -= 1;
        }
      }
      if (entry.pins === 0 && entry.versions.size === 0) this.#evict(hash);
    }
    for (const [hash, entry] of this.#entries)
      if (entry.message.kind === "media_source" && entry.dependencies === 0) this.#evict(hash);
  }

  destroy(): void {
    this.#destroyed = true;
    this.prune();
  }

  #evict(hash: string): void {
    const entry = this.#entries.get(hash);
    requirePlan(entry, "missing_resource", "Cannot evict an absent GPU media hash");
    requirePlan(
      entry.pins === 0 && entry.dependencies === 0,
      "resource_in_use",
      "Cannot evict referenced GPU media",
    );
    if (entry.message.kind === "media_frame") {
      const source = this.#entries.get(entry.message.descriptor.source);
      requirePlan(
        source && source.dependencies > 0,
        "missing_resource",
        "GPU media source dependency is absent",
      );
      source.dependencies -= 1;
    }
    this.#entries.delete(hash);
    this.#versions -= entry.versions.size;
    this.#descriptorBytes -= entry.descriptorBytes;
  }

  #current(version: BindingVersion): boolean {
    return (
      (version.owner.bindingGeneration ?? version.owner.source) === version.source &&
      Object.is(version.owner.lastUploadedTime, version.uploadedTime) &&
      version.owner.bindGroup === version.binding
    );
  }

  #ownerBytes(owner: MediaResource): number {
    return integer(
      owner.textureBytes ?? (owner.textureWidth ?? 0) * (owner.textureHeight ?? 0) * 4,
      1,
    );
  }
}
