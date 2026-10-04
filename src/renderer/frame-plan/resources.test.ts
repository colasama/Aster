import { describe, expect, it, vi } from "vitest";
import { FrameResourceRegistry, resourceHash, validateResourceMessage } from "./resources";
import type { BufferResourceDescriptor, ResourceMessage } from "./types";

async function resource(values: number[]) {
  const bytes = Uint8Array.from(values);
  const descriptor: BufferResourceDescriptor = {
    element_type: "u8",
    element_count: bytes.length,
    byte_length: bytes.length,
  };
  const hash = await resourceHash(descriptor, bytes);
  const message: ResourceMessage = { type: "put_resource", kind: "buffer", hash, descriptor };
  return { bytes, message, hash };
}

describe("content-addressed transport resources", () => {
  it("rejects invalid length and impossible admission before copying or hashing", async () => {
    const entry = await resource([1, 2, 3, 4]);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const registry = new FrameResourceRegistry({ budget_bytes: 3, max_resources: 1 });
    await expect(registry.apply(entry.message, entry.bytes)).rejects.toMatchObject({
      code: "resource_budget_exceeded",
    });
    expect(digest).not.toHaveBeenCalled();
    const other = new FrameResourceRegistry({ budget_bytes: 8, max_resources: 1 });
    const wrong = {
      ...entry.message,
      type: "put_resource" as const,
      kind: "buffer" as const,
      descriptor: { element_type: "u8" as const, element_count: 3, byte_length: 3 },
    };
    await expect(other.apply(wrong, entry.bytes)).rejects.toMatchObject({
      code: "element_count_mismatch",
    });
    expect(digest).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
    digest.mockRestore();
  });

  it("hashes the interpretation and exact bytes, including view offsets", async () => {
    const raw = new Uint8Array([9, 1, 2, 3, 4, 8]).subarray(1, 5);
    const descriptor: BufferResourceDescriptor = {
      element_type: "u8",
      element_count: 4,
      byte_length: 4,
    };
    expect(await resourceHash(descriptor, raw)).toBe(
      await resourceHash(descriptor, new Uint8Array([1, 2, 3, 4])),
    );
    expect(await resourceHash(descriptor, raw)).toBe(
      "49ef9b421b7eeb4a8198c7fae14b3fe7444a0a23ed6da53f2b70943a787f2aa5",
    );
    expect(await resourceHash(descriptor, raw)).not.toBe(
      await resourceHash({ ...descriptor, element_type: "u32_le", element_count: 1 }, raw),
    );
    expect(() =>
      validateResourceMessage({ type: "evict_resource", hash: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      validateResourceMessage({ type: "evict_resource", hash: "a".repeat(64), path: "untrusted" }),
    ).toThrow();
  });

  it("snapshots input before async hashing, deduplicates puts and applies explicit eviction", async () => {
    const registry = new FrameResourceRegistry({ budget_bytes: 4, max_resources: 2 });
    const entry = await resource([1, 2, 3, 4]);
    const pending = registry.apply(entry.message, entry.bytes);
    entry.bytes.fill(9);
    await pending;
    await registry.apply(entry.message, new Uint8Array([1, 2, 3, 4]));
    expect(registry.usedBytes).toBe(4);
    expect(registry.size).toBe(1);
    const lease = registry.pin([entry.hash]);
    await expect(
      registry.apply({ type: "evict_resource", hash: entry.hash }),
    ).rejects.toMatchObject({ code: "resource_in_use" });
    lease.release();
    lease.release();
    await registry.apply({ type: "evict_resource", hash: entry.hash });
    expect(registry.usedBytes).toBe(0);
    expect(() => registry.pin([entry.hash])).toThrow(/Missing resource/);
  });

  it("rejects hash/budget failures and resolves multiple references without partial pins", async () => {
    const registry = new FrameResourceRegistry({ budget_bytes: 4, max_resources: 2 });
    const first = await resource([1, 2, 3, 4]);
    const second = await resource([5]);
    await expect(registry.apply(first.message, new Uint8Array([1, 2, 3, 0]))).rejects.toMatchObject(
      { code: "hash_mismatch" },
    );
    expect(registry.size).toBe(0);
    await registry.apply(first.message, first.bytes);
    await expect(registry.apply(second.message, second.bytes)).rejects.toMatchObject({
      code: "resource_budget_exceeded",
    });
    expect(registry.usedBytes).toBe(4);
    expect(() => registry.pin([first.hash, second.hash])).toThrow(/Missing resource/);
    await registry.apply({ type: "evict_resource", hash: first.hash });
    expect(registry.size).toBe(0);
  });

  it("bounds empty leases and binds release to the registry that created it", () => {
    const first = new FrameResourceRegistry({ budget_bytes: 0, max_resources: 1, max_leases: 1 });
    const second = new FrameResourceRegistry({ budget_bytes: 0, max_resources: 1, max_leases: 1 });
    const a = first.pin([]);
    const b = second.pin([]);
    expect(() => first.pin([])).toThrow(/lease limit/);
    a.release.call(second);
    expect(() => second.pin([])).toThrow(/lease limit/);
    a.release();
    first.pin([]).release();
    b.release();
    second.pin([]).release();
  });
});
