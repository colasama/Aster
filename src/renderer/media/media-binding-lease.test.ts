import { describe, expect, it, vi } from "vitest";
import { MediaBindingLease } from "./media-binding-lease";
import { destroyMediaResource, type MediaResource, retainMediaResources } from "./media-resource";

function resource(): MediaResource {
  return {
    source: "asset",
    kind: "video",
    lastUploadedTime: 1,
    textureWidth: 16,
    textureHeight: 16,
    mediaIdentity: {
      source: { source_id: "asset", content_identity: "content:asset", media_kind: "video" },
      sample: { kind: "image" },
    },
    bindGroup: {} as GPUBindGroup,
    texture: { destroy: vi.fn() } as unknown as GPUTexture,
  };
}

describe("frame-owned media bindings", () => {
  it("returns independent descriptor trees without changing long source identities or clocks", () => {
    const owner = resource();
    if (!owner.mediaIdentity) throw Error("Expected identity");
    owner.mediaIdentity.source.source_id = { utf16_units: [0xd800] };
    owner.mediaIdentity.source.content_identity = "large immutable identity".repeat(10000);
    const lease = new MediaBindingLease([
      { instanceId: "video", resource: owner, binding: owner.bindGroup, requestedTime: 1 },
    ]);
    const expected = lease.resourceMessages;
    const changed = lease.resourceMessages;
    const source = changed.find((m) => m.kind === "media_source");
    const frame = changed.find((m) => m.kind === "media_frame");
    if (
      !source ||
      !frame ||
      typeof source.descriptor.source_id === "string" ||
      frame.descriptor.sample.kind !== "video"
    )
      throw Error("Expected video descriptors");
    source.descriptor.source_id.utf16_units[0] = 65;
    source.descriptor.content_identity = "changed";
    frame.descriptor.sample.requested_time = { kind: "rational", value: 2, scale: 1 };
    expect(lease.resourceMessages).toEqual(expected);
    expect(lease.bindingFor("video")).toBe(owner.bindGroup);
    lease.release();
  });

  it("defers retirement until all submitted owners release and destroys exactly once", () => {
    const owner = resource();
    const first = new MediaBindingLease([
      { instanceId: "a", resource: owner, binding: owner.bindGroup, requestedTime: 1 },
    ]);
    const second = new MediaBindingLease([
      { instanceId: "b", resource: owner, binding: owner.bindGroup, requestedTime: 1 },
    ]);
    destroyMediaResource(owner);
    expect(owner.texture?.destroy).not.toHaveBeenCalled();
    expect(first.bindingFor("a")).toBe(owner.bindGroup);
    expect(() => retainMediaResources([owner])).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    first.release();
    first.release();
    expect(owner.texture?.destroy).not.toHaveBeenCalled();
    second.release();
    destroyMediaResource(owner);
    expect(owner.texture?.destroy).toHaveBeenCalledTimes(1);
    expect(() => second.bindingFor("b")).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
  });

  it("rejects an unknown binding or changed source/frame instead of reading another generation", () => {
    const owner = resource();
    const lease = new MediaBindingLease([
      { instanceId: "video", resource: owner, binding: owner.bindGroup, requestedTime: 1 },
      { instanceId: "pending" },
    ]);
    expect(lease.bindingFor("pending")).toBeUndefined();
    expect(() => lease.bindingFor("unknown")).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    owner.lastUploadedTime = 2;
    expect(() => lease.bindingFor("video")).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
    owner.lastUploadedTime = 1;
    owner.source = "replacement";
    expect(() => lease.bindingFor("video")).toThrow(
      expect.objectContaining({ code: "resource_generation_mismatch" }),
    );
    lease.release();
  });

  it("acquires atomically and does not leak a pin when a later owner was already retired", () => {
    const available = resource();
    const retired = resource();
    destroyMediaResource(retired);
    expect(() => retainMediaResources([available, retired])).toThrow();
    destroyMediaResource(available);
    expect(available.texture?.destroy).toHaveBeenCalledTimes(1);
  });
});
