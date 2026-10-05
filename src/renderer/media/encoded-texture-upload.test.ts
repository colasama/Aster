import { afterEach, expect, it, vi } from "vitest";
import { contentResourceHash, FrameResourceRegistry } from "../frame-plan/resources";
import { prepareEncodedTexture, uploadEncodedTexture } from "./encoded-texture-upload";
import { MaterialTextureRegistry } from "./material-texture-registry";

afterEach(() => vi.unstubAllGlobals());

it("closes oversized decoded images before GPU allocation", async () => {
  const prepared = await prepareEncodedTexture(
    new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
  );
  const bitmap = { width: 4097, height: 1, close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  const device = { limits: { maxTextureDimension2D: 8192 }, createTexture: vi.fn() };
  await expect(
    uploadEncodedTexture(device as unknown as GPUDevice, prepared.message, prepared.bytes, "large"),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(device.createTexture).not.toHaveBeenCalled();
});

it("owns encoded bytes across async admission and rejects corruption before decoding", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const prepared = await prepareEncodedTexture(new Blob([bytes]));
  const registry = new FrameResourceRegistry({ budget_bytes: 100, max_resources: 2 });
  await registry.apply(prepared.message, prepared.bytes);
  expect(registry.usedBytes).toBe(bytes.length);
  vi.stubGlobal("createImageBitmap", vi.fn());
  const changed = new Uint8Array(prepared.bytes);
  changed[8] = 1;
  await expect(
    uploadEncodedTexture({} as GPUDevice, prepared.message, changed, "bad"),
  ).rejects.toMatchObject({ code: "hash_mismatch" });
  expect(createImageBitmap).not.toHaveBeenCalled();
  await expect(registry.apply(prepared.message, changed)).rejects.toMatchObject({
    code: "hash_mismatch",
  });
  const wrong = structuredClone(prepared.message);
  Object.assign(wrong.descriptor, { encoding: "jpeg" });
  await expect(contentResourceHash(wrong, bytes)).rejects.toMatchObject({
    code: "invalid_resource",
  });
});

it("resolves duplicate owners by hash and rejects missing or wrong-role bindings", () => {
  const registry = new MaterialTextureRegistry();
  const first = {} as GPUTexture;
  const second = {} as GPUTexture;
  const identity = "a".repeat(64);
  registry.register(identity, "normal", first);
  registry.register(identity, "normal", second);
  expect(registry.resolve(identity, "normal")).toBe(first);
  expect(() => registry.resolve(identity, "environment")).toThrow(
    expect.objectContaining({ code: "resource_conflict" }),
  );
  registry.retire(identity, first);
  expect(registry.resolve(identity, "normal")).toBe(second);
  registry.retire(identity, second);
  expect(() => registry.resolve(identity, "normal")).toThrow(
    expect.objectContaining({ code: "missing_resource" }),
  );
});
