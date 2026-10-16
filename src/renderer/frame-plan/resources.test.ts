import { describe, expect, it, vi } from "vitest";
import {
  contentResourceHash,
  contentResourceHashSync,
  FrameResourceRegistry,
  resourceHash,
  validateResourceMessage,
} from "./resources";
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
  it("reuses only complete validated media content and rejects changed inputs after a cache hit", async () => {
    const content = {
      kind: "media_source" as const,
      descriptor: {
        source_id: "cache-source",
        content_identity: "generation-1",
        media_kind: "image" as const,
        authorization_scope: "job-1",
      },
    };
    const expected = await contentResourceHash(content);
    expect(contentResourceHashSync(content)).toBe(expected);
    expect(contentResourceHashSync(structuredClone(content))).toBe(expected);
    expect(() => contentResourceHashSync(content, Uint8Array.of(1))).toThrow(/must not carry/);
    for (const field of ["source_id", "content_identity", "authorization_scope"] as const) {
      const changed = structuredClone(content);
      changed.descriptor[field] += "-changed";
      expect(contentResourceHashSync(changed)).not.toBe(expected);
      expect(contentResourceHashSync(changed)).toBe(await contentResourceHash(changed));
    }
    const malformed = structuredClone(content);
    Object.assign(malformed.descriptor, { extra: true });
    expect(() => contentResourceHashSync(malformed)).toThrow(/exactly these fields/);
    content.descriptor.content_identity = "invalid\ud800";
    expect(() => contentResourceHashSync(content)).toThrow();
  });

  it("treats an admitted media hash only as a hint and privately owns its validated fields", async () => {
    const content = {
      kind: "media_source" as const,
      descriptor: {
        source_id: "verified-cache-source",
        content_identity: "immutable-generation",
        media_kind: "image" as const,
        authorization_scope: "verified-job",
      },
    };
    const expected = await contentResourceHash(content);
    const message = { ...content, type: "put_resource" as const, hash: expected };
    expect(contentResourceHashSync(message)).toBe(expected);
    expect(contentResourceHashSync(structuredClone(message))).toBe(expected);
    const forged = { ...message, hash: "0".repeat(64) };
    expect(contentResourceHashSync(forged)).toBe(expected);
    const changed = structuredClone(message);
    changed.descriptor.content_identity = "different-generation";
    expect(contentResourceHashSync(changed)).toBe(await contentResourceHash(changed));
    expect(contentResourceHashSync(changed)).not.toBe(expected);
    expect(contentResourceHashSync(message)).toBe(expected);
    Object.assign(changed.descriptor, { unexpected: true });
    expect(() => contentResourceHashSync(changed)).toThrow(/exactly these fields/);
    expect(() => contentResourceHashSync(message, Uint8Array.of(1))).toThrow(/must not carry/);
    message.descriptor.content_identity = "invalid\ud800";
    expect(() => contentResourceHashSync(message)).toThrow();
    const restored = {
      ...message,
      descriptor: { ...message.descriptor, content_identity: "immutable-generation" },
    };
    expect(contentResourceHashSync(restored)).toBe(expected);
    for (let index = 0; index < 160; index++)
      contentResourceHashSync({
        ...content,
        descriptor: {
          ...restored.descriptor,
          content_identity: `eviction-${index}-${"x".repeat(10000)}`,
        },
      });
    expect(contentResourceHashSync(restored)).toBe(expected);
    expect(() => contentResourceHashSync(message)).toThrow();
  });

  it("keeps segmented synchronous hashes equal to the wire digest across payload boundaries", async () => {
    for (const size of [1, 55, 56, 63, 64, 65, 4097, 4 * 1024 * 1024]) {
      const storage = new Uint8Array(size + 7).fill(0xa5);
      const bytes = storage.subarray(3, size + 3);
      for (let index = 0; index < size; index++) bytes[index] = index % 251;
      const descriptor = { element_type: "u8" as const, element_count: size, byte_length: size };
      expect(contentResourceHashSync({ kind: "buffer", descriptor }, bytes)).toBe(
        await resourceHash(descriptor, bytes),
      );
      expect(storage[2]).toBe(0xa5);
      expect(storage[size + 3]).toBe(0xa5);
    }
    const descriptor = { element_type: "u8" as const, element_count: 4, byte_length: 4 };
    expect(contentResourceHashSync({ kind: "buffer", descriptor }, Uint8Array.of(1, 2, 3, 4))).toBe(
      "49ef9b421b7eeb4a8198c7fae14b3fe7444a0a23ed6da53f2b70943a787f2aa5",
    );
    expect(() => contentResourceHashSync({ kind: "buffer", descriptor }, Uint8Array.of(1))).toThrow(
      /length mismatch/,
    );
  });

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
