import { describe, expect, it, vi } from "vitest";
import { encodeFramePlan } from "../frame-plan/codec";
import { frameBundleFixtures } from "../frame-plan/frame-bundle-fixture";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import type { MediaBindingLease } from "../media/media-binding-lease";
import type { NativeRasterCaptureCache } from "../media/native-raster-capture-cache";
import { VerifiedMediaPixels } from "../media/verified-media-pixels";
import { captureSubmittedFrameBundle } from "./frame-bundle-capture";
import { nativeFramePacket, nativeFramePacketWithRasters } from "./native-frame-packet";
import { withNativeFrameRasters } from "./native-frame-rasters";

function rasterFixture() {
  const expected = frameBundleFixtures()[2].frameBundle;
  const captures = readFrameBundle(expected).mediaPixels;
  const hashes = new Set(captures.map((capture) => capture.pixels.message.hash));
  const input = structuredClone(expected);
  const root = input.plan.metadata.slices[0];
  if (root.kind !== "frame_bundle") throw Error("Missing fixture bundle");
  root.media_pixels = [];
  new DataView(input.plan.blobs[0].buffer).setUint32(16, 0, true);
  input.plan.metadata.resources = input.plan.metadata.resources.filter((hash) => !hashes.has(hash));
  input.resources = input.resources.filter((resource) => !hashes.has(resource.message.hash));
  return { input, captures, expected };
}

describe("native frame transfer ownership", () => {
  it("emits identical direct packets without copying retained private raster payloads", async () => {
    const { input, captures, expected } = rasterFixture();
    const proofs = await Promise.all(captures.map(VerifiedMediaPixels.verify));
    const full = nativeFramePacketWithRasters(input, proofs);
    expect(full).toEqual(nativeFramePacket(expected));
    const retained = new Set(full.resources.map((resource) => resource.message.hash));
    const copy = vi.spyOn(VerifiedMediaPixels, "copyResource");
    try {
      expect(nativeFramePacketWithRasters(input, proofs, retained)).toEqual(
        nativeFramePacket(expected, retained),
      );
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
    const description = VerifiedMediaPixels.describe(proofs[0]);
    description.frame.hash = "0".repeat(64);
    description.pixels.message.hash = "0".repeat(64);
    for (const resource of full.resources) new Uint8Array(resource.bytes).fill(0);
    expect(nativeFramePacketWithRasters(input, proofs)).toEqual(nativeFramePacket(expected));
  });

  it("rejects forged proofs, mismatched declarations and oversized logical reference packets", async () => {
    const { input, captures } = rasterFixture();
    const proofs = await Promise.all(captures.map(VerifiedMediaPixels.verify));
    expect(() =>
      nativeFramePacketWithRasters(input, [Object.create(VerifiedMediaPixels.prototype)]),
    ).toThrow();
    expect(() => nativeFramePacketWithRasters(input, [])).toThrow(/coverage/);
    const changed = structuredClone(input);
    const frame = changed.resources.find(
      (packet) => packet.message.hash === captures[0].frame.hash,
    );
    if (!frame) throw Error("Fixture frame absent");
    Object.assign(frame.message.descriptor, { extra: true });
    expect(() => nativeFramePacketWithRasters(changed, proofs)).toThrow(/identity differs/);
    const bytes = new Uint8Array(64 * 1024 * 1024);
    const hash = "e".repeat(64);
    const oversized = {
      ...input,
      resources: [
        ...input.resources,
        {
          message: {
            type: "put_resource" as const,
            hash,
            kind: "buffer" as const,
            descriptor: {
              element_type: "u8" as const,
              element_count: bytes.length,
              byte_length: bytes.length,
            },
          },
          bytes,
        },
      ],
    };
    expect(() =>
      nativeFramePacketWithRasters(
        oversized,
        proofs,
        new Set([hash, ...input.resources.map((r) => r.message.hash)]),
      ),
    ).toThrow(/budget/);
  });

  it("retains and copies only the verified pixel view from a larger readback buffer", async () => {
    const { captures } = rasterFixture();
    const capture = captures[0];
    const expected = structuredClone(capture);
    const backing = new Uint8Array(capture.pixels.bytes.length + 8192);
    backing.set(capture.pixels.bytes, 4096);
    capture.pixels.bytes = backing.subarray(4096, 4096 + capture.pixels.bytes.length);
    const pending = VerifiedMediaPixels.verify(capture);
    backing.fill(0);
    const verified = await pending;
    const copied = VerifiedMediaPixels.copy(verified);
    expect(copied).toEqual(expected);
    expect(copied.pixels.bytes.byteOffset).toBe(0);
    expect(copied.pixels.bytes.buffer.byteLength).toBe(copied.pixels.bytes.length);
    expect(VerifiedMediaPixels.byteLength(verified)).toBe(expected.pixels.bytes.length);
    copied.pixels.bytes.fill(0);
    copied.frame.hash = "0".repeat(64);
    copied.pixels.message.hash = "0".repeat(64);
    expect(VerifiedMediaPixels.copy(verified)).toEqual(expected);
  });

  it("reuses private verified snapshots without trusting forged proofs or mutable copies", async () => {
    const { input, captures, expected } = rasterFixture();
    const pending = Promise.all(captures.map(VerifiedMediaPixels.verify));
    for (const capture of captures) capture.pixels.bytes.fill(0);
    const proofs = await pending;
    const copy = VerifiedMediaPixels.copy(proofs[0]);
    copy.pixels.bytes.fill(0);
    structuredClone(copy.pixels.bytes, { transfer: [copy.pixels.bytes.buffer] });
    expect(await withNativeFrameRasters(input, proofs)).toEqual(expected);
    expect(await withNativeFrameRasters(input, proofs)).toEqual(expected);
    await expect(VerifiedMediaPixels.verify(captures[0])).rejects.toThrow(/hash differs/);
    const forged = Object.create(VerifiedMediaPixels.prototype) as VerifiedMediaPixels;
    await expect(withNativeFrameRasters(input, [forged, ...proofs.slice(1)])).rejects.toThrow();
    expect(() => Reflect.construct(VerifiedMediaPixels, [Symbol(), captures[0]])).toThrow(/token/);
    const different = rasterFixture();
    different.input.resources = different.input.resources.filter(
      (packet) => packet.message.hash !== VerifiedMediaPixels.frameHash(proofs[0]),
    );
    await expect(withNativeFrameRasters(different.input, proofs)).rejects.toThrow(/coverage/);
    Object.assign(different.captures[0].pixels.message, { unexpected: true });
    await expect(VerifiedMediaPixels.verify(different.captures[0])).rejects.toThrow(
      /exactly these fields/,
    );
  });

  it("owns the plan and all transferred packets", () => {
    const fixture = frameBundleFixtures()[1].frameBundle;
    const input = structuredClone(fixture);
    const packet = nativeFramePacket(input);
    input.plan.blobs[0].fill(0);
    for (const resource of input.resources) resource.bytes.fill(0);
    expect(new Uint8Array(packet.plan)).toEqual(
      encodeFramePlan(fixture.plan.metadata, fixture.plan.blobs),
    );
    expect(packet.resources.map((resource) => new Uint8Array(resource.bytes))).toEqual(
      fixture.resources.map((resource) => resource.bytes),
    );
  });

  it("omits retained payload copies while owning new bytes and preserving the complete plan", () => {
    const fixture = frameBundleFixtures()[1].frameBundle;
    const input = structuredClone(fixture);
    const retained = new Set(input.resources.slice(0, -1).map((resource) => resource.message.hash));
    const packet = nativeFramePacket(input, retained);
    const full = nativeFramePacket(fixture);
    expect(packet.plan).toEqual(full.plan);
    expect(packet.retainedResources).toEqual([...retained]);
    expect(packet.resources).toEqual(full.resources.slice(-1));
    for (const resource of input.resources) {
      resource.bytes.fill(0);
      resource.message.hash = "0".repeat(64);
    }
    retained.clear();
    expect(packet.retainedResources).toEqual(
      full.resources.slice(0, -1).map((r) => r.message.hash),
    );
    expect(packet.resources).toEqual(full.resources.slice(-1));
    const oversized = structuredClone(fixture);
    oversized.resources[0].bytes = new Uint8Array(64 * 1024 * 1024);
    expect(() =>
      nativeFramePacket(oversized, new Set(oversized.resources.map((r) => r.message.hash))),
    ).toThrow("transport budget");
  });

  it("attaches identical temporal raster bytes and rejects changed or missing captures", async () => {
    const { input, captures, expected } = rasterFixture();
    const copied = structuredClone(captures);
    const pending = withNativeFrameRasters(input, copied);
    copied[0].pixels.bytes.fill(0);
    const actual = await pending;
    expect(actual).toEqual(expected);
    expect(nativeFramePacket(actual).resources.length).toBe(expected.resources.length);
    await expect(withNativeFrameRasters(input, [])).rejects.toThrow(/coverage/);
    await expect(withNativeFrameRasters(input, copied)).rejects.toThrow(/hash mismatch/);
    Object.assign(captures[0].pixels.message, { unexpected: true });
    await expect(withNativeFrameRasters(input, captures)).rejects.toThrow(/exactly these fields/);
  });

  it("snapshots once before deferred capture and releases the retained GPU owner on either outcome", async () => {
    const { input, captures, expected } = rasterFixture();
    const submitted = structuredClone(input.plan);
    let complete = () => {};
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const release = vi.fn();
    const retainForCapture = vi.fn(() => ({ release }));
    const media = { retainForCapture } as unknown as MediaBindingLease;
    const capture = vi.fn(async () => {
      await gate;
      return captures;
    });
    const rasters = { captureVerified: capture } as unknown as NativeRasterCaptureCache;
    const pending = captureSubmittedFrameBundle({} as GPUDevice, input, media, "raster", rasters);
    input.plan.blobs[0].fill(0);
    for (const resource of input.resources) {
      resource.bytes.fill(0);
      resource.message.hash = "0".repeat(64);
    }
    expect(release).not.toHaveBeenCalled();
    complete();
    const actual = await pending;
    expect(actual).toEqual({ ...expected, submittedPlan: submitted });
    expect(retainForCapture).toHaveBeenCalledWith(captures.map((capture) => capture.frame.hash));
    expect(release).toHaveBeenCalledOnce();
    for (const capture of captures) capture.pixels.bytes.fill(0);
    expect(actual).toEqual({ ...expected, submittedPlan: submitted });
    capture.mockRejectedValueOnce(new Error("Readback failed"));
    await expect(
      captureSubmittedFrameBundle({} as GPUDevice, rasterFixture().input, media, "raster", rasters),
    ).rejects.toThrow("Readback failed");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not expose the private declaration snapshot to a deferred capture callback", async () => {
    const { input, captures, expected } = rasterFixture();
    const actual = await withNativeFrameRasters(input, async (frames) => {
      frames[0].hash = "0".repeat(64);
      return captures;
    });
    expect(actual).toEqual(expected);
  });

  it("refuses file-media pixel captures at the transport boundary", () => {
    expect(() => nativeFramePacket(frameBundleFixtures()[0].frameBundle)).toThrow(
      /file-media pixels/,
    );
  });
});
