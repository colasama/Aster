import { requirePlan } from "../frame-plan/canonical";
import type { PutResource } from "../frame-plan/types";
import type { MediaGpuLease } from "./media-gpu-registry";
import { type CapturedMediaPixels, createMediaPixelPayloadAsync } from "./media-pixel-payload";
import { readRetainedMediaPixels } from "./media-pixel-readback";

/** The caller holds the frame lease until capture completes; preview never invokes readback. */
export async function captureMediaPixels(
  device: GPUDevice,
  lease: Pick<MediaGpuLease, "textureForHash">,
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
  const textures = selected.map((frame) => lease.textureForHash(frame.hash));
  const pixels = await readRetainedMediaPixels(device, textures);
  for (const [index, frame] of selected.entries()) {
    requirePlan(
      lease.textureForHash(frame.hash) === textures[index],
      "resource_generation_mismatch",
      "Media changed during capture",
    );
  }
  const result: CapturedMediaPixels[] = [];
  // Bound native digest concurrency without serializing every small raster's thread handoff.
  for (let first = 0; first < selected.length; first += 32)
    result.push(
      ...(await Promise.all(
        selected
          .slice(first, first + 32)
          .map((frame, index) => createMediaPixelPayloadAsync(frame, pixels[first + index])),
      )),
    );
  return result;
}
