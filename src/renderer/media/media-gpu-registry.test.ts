import { describe, expect, it, vi } from "vitest";
import { contentResourceHashSync } from "../frame-plan/resources";
import { mediaFrameMessages } from "./media-frame-identity";
import { MediaGpuRegistry } from "./media-gpu-registry";
import { destroyMediaResource, type MediaResource } from "./media-resource";

function owner(): MediaResource {
  return {
    source: "asset",
    kind: "image",
    texture: { destroy: vi.fn() } as unknown as GPUTexture,
    bindGroup: {} as GPUBindGroup,
    textureBytes: 16,
    textureWidth: 2,
    textureHeight: 2,
    mediaIdentity: {
      source: { source_id: "asset", content_identity: "asset-v1", media_kind: "image" },
      sample: { kind: "image" },
    },
  };
}

function admit(registry: MediaGpuRegistry, resource: MediaResource) {
  const [source, frame] = mediaFrameMessages(resource, "snapshot");
  registry.apply(source);
  registry.apply(frame, resource, resource.bindGroup);
  return { source, frame };
}

describe("persistent GPU media registrations", () => {
  it("owns admitted descriptors independently of later caller mutations", () => {
    const registry = new MediaGpuRegistry();
    const resource = owner();
    if (!resource.mediaIdentity) throw Error("Expected identity");
    resource.mediaIdentity.source.source_id = { utf16_units: [97, 0xd800] };
    resource.mediaIdentity.source.content_identity = "identity".repeat(10000);
    const { source, frame } = admit(registry, resource);
    const original = structuredClone(source);
    if (source.kind !== "media_source" || typeof source.descriptor.source_id === "string")
      throw Error("Expected source units");
    source.descriptor.source_id.utf16_units[0] = 98;
    source.descriptor.content_identity = "changed";
    expect(() => registry.apply(source)).toThrow(
      expect.objectContaining({ code: "hash_mismatch" }),
    );
    registry.apply(original);
    registry.apply(frame, resource, resource.bindGroup);
    const lease = registry.pin([frame.hash]);
    expect(lease.bindingForHash(frame.hash)).toBe(resource.bindGroup);
    lease.release();
    registry.destroy();
  });

  it("authenticates changed descriptors despite a known hash and never skips binding checks", () => {
    const registry = new MediaGpuRegistry();
    const resource = owner();
    const { source, frame } = admit(registry, resource);
    const forged = structuredClone(source);
    if (forged.kind !== "media_source") throw Error("Expected source");
    forged.descriptor.content_identity = "different bytes";
    expect(() => registry.apply(forged)).toThrow(
      expect.objectContaining({ code: "hash_mismatch" }),
    );
    const extra = { ...source, extra: true };
    expect(() => registry.apply(extra)).toThrow();
    registry.apply(structuredClone(source));
    resource.bindGroup = {} as GPUBindGroup;
    expect(() => registry.apply(frame, resource, resource.bindGroup)).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
    registry.destroy();
    expect(() => registry.apply(source)).toThrow(/destroyed/);
  });

  it("deduplicates puts, rejects mismatched handles and absent hashes, and protects dependencies", () => {
    const registry = new MediaGpuRegistry();
    const resource = owner();
    const { source, frame } = admit(registry, resource);
    const before = registry.statistics;
    admit(registry, resource);
    expect(registry.statistics).toEqual(before);
    expect(() =>
      registry.apply({ ...frame, hash: "0".repeat(64) }, resource, resource.bindGroup),
    ).toThrow(expect.objectContaining({ code: "hash_mismatch" }));
    expect(() => registry.apply(frame, resource, {} as GPUBindGroup)).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    expect(() => registry.pin([frame.hash, "0".repeat(64)])).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    const lease = registry.pin([frame.hash]);
    expect(lease.bindingForHash(frame.hash)).toBe(resource.bindGroup);
    expect(() => registry.apply({ type: "evict_resource", hash: frame.hash })).toThrow(
      expect.objectContaining({ code: "resource_in_use" }),
    );
    expect(() => registry.apply({ type: "evict_resource", hash: source.hash })).toThrow(
      expect.objectContaining({ code: "resource_in_use" }),
    );
    lease.release();
    registry.apply({ type: "evict_resource", hash: frame.hash });
    registry.apply({ type: "evict_resource", hash: source.hash });
    expect(registry.statistics).toEqual({ resources: 0, descriptorBytes: 0, gpuBytes: 0 });
    expect(() => registry.pin([frame.hash])).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    expect(resource.texture?.destroy).not.toHaveBeenCalled(); // The cache still owns this allocation.
  });

  it("keeps replaced owners resident until their independent GPU leases complete", () => {
    const registry = new MediaGpuRegistry();
    const old = owner();
    const { frame } = admit(registry, old);
    const first = registry.pin([frame.hash]);
    destroyMediaResource(old);
    const replacement = owner();
    admit(registry, replacement);
    const second = registry.pin([frame.hash]);
    expect(first.bindingForHash(frame.hash)).toBe(old.bindGroup);
    expect(second.bindingForHash(frame.hash)).toBe(replacement.bindGroup);
    expect(registry.statistics.gpuBytes).toBe(32);
    registry.destroy();
    destroyMediaResource(replacement);
    expect(registry.statistics.gpuBytes).toBe(32);
    first.release();
    expect(old.texture?.destroy).toHaveBeenCalledOnce();
    expect(replacement.texture?.destroy).not.toHaveBeenCalled();
    expect(registry.statistics.gpuBytes).toBe(16);
    second.release();
    expect(replacement.texture?.destroy).toHaveBeenCalledOnce();
    expect(registry.statistics).toEqual({ resources: 0, descriptorBytes: 0, gpuBytes: 0 });
  });

  it("rejects obsolete video bindings without invalidating submitted ownership", () => {
    const registry = new MediaGpuRegistry();
    const resource = owner();
    resource.kind = "video";
    if (resource.mediaIdentity) resource.mediaIdentity.source.media_kind = "video";
    resource.lastUploadedTime = 0;
    const messages = mediaFrameMessages(resource, "snapshot", 0.0001);
    registry.apply(messages[0]);
    registry.apply(messages[1], resource, resource.bindGroup);
    const lease = registry.pin([messages[1].hash]);
    resource.lastUploadedTime = 1;
    expect(() => lease.bindingForHash(messages[1].hash)).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
    expect(() => registry.pin([messages[1].hash])).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
    destroyMediaResource(resource);
    expect(resource.texture?.destroy).not.toHaveBeenCalled();
    lease.release();
    expect(resource.texture?.destroy).toHaveBeenCalledOnce();
    expect(registry.statistics.resources).toBe(0);
  });

  it("bounds registered bytes and counts aliases of a physical texture once", () => {
    const resource = owner();
    const tiny = new MediaGpuRegistry({ gpuBytes: 15 });
    const [source, frame] = mediaFrameMessages(resource, "snapshot");
    tiny.apply(source);
    const before = tiny.statistics;
    expect(() => tiny.apply(frame, resource, resource.bindGroup)).toThrow(
      expect.objectContaining({ code: "resource_budget_exceeded" }),
    );
    expect(tiny.statistics).toEqual(before);
    const metadataLimited = new MediaGpuRegistry({ descriptorBytes: 1 });
    expect(() => metadataLimited.apply(source)).toThrow(
      expect.objectContaining({ code: "resource_budget_exceeded" }),
    );
    const registry = new MediaGpuRegistry({ gpuBytes: 16 });
    admit(registry, resource);
    const alternate = mediaFrameMessages(resource, "another-scope");
    registry.apply(alternate[0]);
    registry.apply(alternate[1], resource, resource.bindGroup);
    expect(registry.statistics.gpuBytes).toBe(16);
    const wrong = structuredClone(frame);
    if (wrong.kind !== "media_frame") throw Error("Expected frame");
    wrong.descriptor.width = 3;
    wrong.hash = contentResourceHashSync(wrong);
    expect(() => registry.apply(wrong, resource, resource.bindGroup)).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
  });

  it("bounds leases and replaced physical bindings even when descriptor hashes are reused", () => {
    const registry = new MediaGpuRegistry({ maxResources: 2, maxLeases: 2 });
    const first = owner();
    const { frame } = admit(registry, first);
    const firstLease = registry.pin([frame.hash]);
    destroyMediaResource(first);
    const second = owner();
    admit(registry, second);
    const secondLease = registry.pin([frame.hash]);
    destroyMediaResource(second);
    const third = owner();
    expect(() => admit(registry, third)).toThrow(
      expect.objectContaining({ code: "resource_budget_exceeded" }),
    );
    expect(() => registry.pin([])).toThrow(
      expect.objectContaining({ code: "resource_budget_exceeded" }),
    );
    firstLease.release();
    firstLease.release();
    admit(registry, third);
    const empty = registry.pin([]);
    expect(() => registry.pin([])).toThrow(
      expect.objectContaining({ code: "resource_budget_exceeded" }),
    );
    empty.release();
    secondLease.release();
    registry.apply({ type: "evict_resource", hash: frame.hash });
    admit(registry, owner());
    expect(registry.statistics.gpuBytes).toBe(16);
    registry.destroy();
  });
});
