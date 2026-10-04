import { describe, expect, it } from "vitest";
import { mediaResourceFixtures } from "./media-resource-fixture";
import { contentResourceHash, FrameResourceRegistry, validateResourceMessage } from "./resources";
import type { PutResource } from "./types";

describe("media resource transport", () => {
  it("owns descriptors, requires matching sources, and retains dependencies through eviction", async () => {
    const [source, frame] = await mediaResourceFixtures();
    const registry = new FrameResourceRegistry({ budget_bytes: 10000, max_resources: 10 });
    await expect(registry.apply(frame)).rejects.toMatchObject({ code: "missing_resource" });
    expect(registry.size).toBe(0);
    const input = structuredClone(source);
    const pending = registry.apply(input);
    if (input.kind === "media_source") input.descriptor.content_identity = "changed";
    await pending;
    expect(registry.resolve(source.hash).content.descriptor).toEqual(source.descriptor);
    await registry.apply(frame);
    await registry.apply(frame);
    await expect(
      registry.apply({ type: "evict_resource", hash: source.hash }),
    ).rejects.toMatchObject({ code: "resource_in_use" });
    const lease = registry.pin([frame.hash]);
    await expect(
      registry.apply({ type: "evict_resource", hash: frame.hash }),
    ).rejects.toMatchObject({ code: "resource_in_use" });
    lease.release();
    await registry.apply({ type: "evict_resource", hash: frame.hash });
    await registry.apply({ type: "evict_resource", hash: source.hash });
    expect(registry.usedBytes).toBe(0);
    expect(() => registry.resolve(frame.hash)).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
  });

  it("binds sample identity, denies wrong hashes and charges descriptor memory", async () => {
    const messages = await mediaResourceFixtures();
    expect(new Set(messages.map((m) => m.hash)).size).toBe(messages.length);
    const tiny = new FrameResourceRegistry({ budget_bytes: 1, max_resources: 10 });
    await expect(tiny.apply(messages[0])).rejects.toMatchObject({
      code: "resource_budget_exceeded",
    });
    const registry = new FrameResourceRegistry({ budget_bytes: 10000, max_resources: 20 });
    await expect(registry.apply({ ...messages[0], hash: "0".repeat(64) })).rejects.toMatchObject({
      code: "hash_mismatch",
    });
    for (const message of messages) await registry.apply(message);
    const frame = structuredClone(messages[1]);
    if (frame.kind !== "media_frame") throw Error("Expected media frame");
    frame.descriptor.sample = { kind: "sequence", frame: 0, file_identity: "member:0" };
    frame.hash = await contentResourceHash(frame);
    const before = registry.usedBytes;
    await expect(registry.apply(frame)).rejects.toMatchObject({ code: "resource_conflict" });
    expect(registry.usedBytes).toBe(before);
    const altered = { ...messages[1], descriptor: { ...messages[1].descriptor, dom_handle: {} } };
    expect(() => validateResourceMessage(altered)).toThrow();
    await expect(registry.apply(messages[0], new Uint8Array([1]))).rejects.toMatchObject({
      code: "element_count_mismatch",
    });
  });

  it("rejects source removal while hashing a frame and never installs an orphan", async () => {
    const [source, frame] = await mediaResourceFixtures();
    const registry = new FrameResourceRegistry({ budget_bytes: 10000, max_resources: 20 });
    await registry.apply(source);
    const pending = registry.apply(frame);
    await registry.apply({ type: "evict_resource", hash: source.hash });
    await expect(pending).rejects.toMatchObject({ code: "missing_resource" });
    expect(registry.size).toBe(0);
    expect(registry.usedBytes).toBe(0);
    const invalid = { ...frame, kind: "unsupported" } as unknown as PutResource;
    expect(() => validateResourceMessage(invalid)).toThrow();
  });
});
