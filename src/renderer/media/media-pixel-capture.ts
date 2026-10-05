import { requirePlan } from "../frame-plan/canonical";
import type { PutResource } from "../frame-plan/types";
import { GpuFrameReadbackPool } from "../gpu/frame-readback";
import type { MediaBindingLease } from "./media-binding-lease";
import { type CapturedMediaPixels, createMediaPixelPayload } from "./media-pixel-payload";

/** The caller holds the frame lease until capture completes; preview never invokes readback. */
export async function captureMediaPixels(
  device: GPUDevice,
  lease: MediaBindingLease,
  frames: readonly PutResource[],
): Promise<CapturedMediaPixels[]> {
  const selected = structuredClone(frames);
  const ids = new Set<string>();
  let bytes = 0;
  for (const frame of selected) {
    requirePlan(
      frame.kind === "media_frame" && !ids.has(frame.hash),
      "invalid_resource",
      "Invalid media capture selection",
    );
    ids.add(frame.hash);
    bytes += frame.descriptor.width * frame.descriptor.height * 4;
    const texture = lease.textureForHash(frame.hash);
    requirePlan(
      texture.format === frame.descriptor.format &&
        texture.width === frame.descriptor.width &&
        texture.height === frame.descriptor.height &&
        (texture.usage & GPUTextureUsage.COPY_SRC) !== 0,
      "resource_generation_mismatch",
      "Pinned media texture differs from its frame",
    );
  }
  requirePlan(
    bytes <= 64 * 1024 * 1024 && selected.length <= 65536,
    "resource_budget_exceeded",
    "Media capture exceeds frame budget",
  );
  const pool = new GpuFrameReadbackPool(device, "rgba8unorm-srgb", 1);
  const result: CapturedMediaPixels[] = [];
  try {
    for (const frame of selected) {
      if (frame.kind !== "media_frame") throw Error("Invalid media capture frame");
      const texture = lease.textureForHash(frame.hash);
      const ticket = pool.reserve(frame.descriptor.width, frame.descriptor.height);
      try {
        const encoder = device.createCommandEncoder({ label: "Retained media pixel capture" });
        ticket.encode(encoder, texture);
        device.queue.submit([encoder.finish()]);
        const captured = await ticket.read();
        requirePlan(
          lease.textureForHash(frame.hash) === texture,
          "resource_generation_mismatch",
          "Media changed during capture",
        );
        result.push(createMediaPixelPayload(frame, new Uint8Array(captured.pixels)));
      } catch (error) {
        ticket.abort();
        throw error;
      }
    }
    return result;
  } finally {
    pool.destroy();
  }
}
