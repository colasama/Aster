import { beforeEach, expect, it, vi } from "vitest";
import type { PutResource } from "../frame-plan/types";
import { mediaFrameMessages, preparedRasterIdentity } from "./media-frame-identity";
import { captureMediaPixels } from "./media-pixel-capture";
import { createMediaPixelPayload } from "./media-pixel-payload";
import { NativeRasterCaptureCache } from "./native-raster-capture-cache";
import { VerifiedMediaPixels } from "./verified-media-pixels";

vi.mock("./media-pixel-capture", () => ({ captureMediaPixels: vi.fn() }));
const device = {} as GPUDevice;
const textures = new Map<string, GPUTexture>();
const lease = {
  textureForHash: (hash: string) => {
    const texture = textures.get(hash);
    if (!texture) throw Error("Missing retained texture");
    return texture;
  },
};
function frame(id: string, extent = 2): PutResource {
  const frame = mediaFrameMessages(
    {
      kind: "text",
      source: id,
      textureWidth: extent,
      textureHeight: extent,
      mediaIdentity: preparedRasterIdentity(id, "text", id, {
        x: 0,
        y: 0,
        width: extent,
        height: extent,
      }),
    },
    "snapshot",
  )[1];
  textures.set(frame.hash, {} as GPUTexture);
  return frame;
}
function pixels(frame: PutResource) {
  if (frame.kind !== "media_frame") throw Error("Expected media frame");
  return createMediaPixelPayload(
    frame,
    new Uint8Array(frame.descriptor.width * frame.descriptor.height * 4).fill(17),
  );
}
beforeEach(() => {
  textures.clear();
  vi.mocked(captureMediaPixels)
    .mockReset()
    .mockImplementation(async (_device, _lease, frames) => frames.map(pixels));
});

it("reuses the verified owner only across the same texture generation", async () => {
  const cache = new NativeRasterCaptureCache(),
    a = frame("a");
  const [first] = await cache.captureVerified(device, lease, [a]);
  const copy = VerifiedMediaPixels.copy(first);
  copy.pixels.bytes.fill(0);
  structuredClone(copy.pixels.bytes, { transfer: [copy.pixels.bytes.buffer] });
  expect((await cache.captureVerified(device, lease, [a]))[0]).toBe(first);
  expect(VerifiedMediaPixels.copy(first).pixels.bytes[0]).toBe(17);
  textures.set(a.hash, {} as GPUTexture);
  expect((await cache.captureVerified(device, lease, [a]))[0]).not.toBe(first);
  cache.clear();
  expect(VerifiedMediaPixels.copy(first).pixels.bytes[0]).toBe(17);
});

it("rejects invalid pixels and changed generations before publishing any capture", async () => {
  const cache = new NativeRasterCaptureCache(),
    a = frame("a"),
    b = frame("b");
  const corrupted = pixels(b);
  corrupted.pixels.bytes[0]++;
  vi.mocked(captureMediaPixels).mockResolvedValueOnce([pixels(a), corrupted]);
  await expect(cache.captureVerified(device, lease, [a, b])).rejects.toThrow(/hash differs/);
  expect(cache.statistics).toEqual({ bytes: 0, entries: 0 });
  vi.mocked(captureMediaPixels).mockImplementationOnce(async () => {
    textures.set(a.hash, {} as GPUTexture);
    return [pixels(a)];
  });
  await expect(cache.captureVerified(device, lease, [a])).rejects.toThrow(/changed during capture/);
  expect(cache.statistics).toEqual({ bytes: 0, entries: 0 });
});

it("reuses only the same authenticated texture generation and keeps caller bytes separate", async () => {
  const cache = new NativeRasterCaptureCache(),
    a = frame("a");
  const first = await cache.capture(device, lease, [a]);
  first[0].pixels.bytes.fill(0);
  first[0].frame.hash = "changed";
  expect((await cache.capture(device, lease, [a]))[0].pixels.bytes[0]).toBe(17);
  textures.set(a.hash, {} as GPUTexture);
  await cache.capture(device, lease, [a]);
  expect(vi.mocked(captureMediaPixels).mock.calls.map((call) => call[2].length)).toEqual([1, 0, 1]);
  const invalid = structuredClone(a);
  if (invalid.kind !== "media_frame") throw Error("Expected media");
  invalid.descriptor.width++;
  await expect(cache.capture(device, lease, [invalid])).rejects.toThrow("authenticated");
});

it("evicts least recently used captures within byte and entry bounds", async () => {
  const cache = new NativeRasterCaptureCache(32, 2),
    a = frame("a"),
    b = frame("b"),
    c = frame("c");
  await cache.capture(device, lease, [a, b]);
  await cache.capture(device, lease, [a]);
  await cache.capture(device, lease, [c]);
  await cache.capture(device, lease, [b]);
  expect(vi.mocked(captureMediaPixels).mock.calls.map((call) => call[2].length)).toEqual([
    2, 0, 1, 1,
  ]);
  expect(cache.statistics).toEqual({ bytes: 32, entries: 2 });
  const disabled = new NativeRasterCaptureCache(0, 0);
  await disabled.capture(device, lease, [a]);
  expect(disabled.statistics).toEqual({ bytes: 0, entries: 0 });
});

it("does not publish failed or disposed captures and enforces the aggregate frame bound", async () => {
  const cache = new NativeRasterCaptureCache(),
    a = frame("a"),
    b = frame("b");
  await cache.capture(device, lease, [a]);
  vi.mocked(captureMediaPixels).mockRejectedValueOnce(Error("readback failed"));
  await expect(cache.capture(device, lease, [a, b])).rejects.toThrow("readback failed");
  expect(cache.statistics).toEqual({ bytes: 16, entries: 1 });
  let complete!: (value: ReturnType<typeof pixels>[]) => void;
  vi.mocked(captureMediaPixels).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = cache.capture(device, lease, [b]);
  cache.clear();
  complete([pixels(b)]);
  await pending;
  expect(cache.statistics).toEqual({ bytes: 0, entries: 0 });
  await expect(
    cache.capture(device, lease, [frame("large-a", 4096), frame("large-b", 4096)]),
  ).rejects.toThrow("frame budget");
});
