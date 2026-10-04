import { requirePlan } from "../frame-plan/canonical";
import { createRasterPixels } from "../frame-plan/raster-resource";
import { FrameResourceRegistry } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";
import { GpuFrameReadbackPool } from "../gpu/frame-readback";
import { mediaFrameMessages } from "./media-frame-identity";
import { destroyMediaResource, type MediaResource, retainMediaResources } from "./media-resource";
import { uploadRasterResource } from "./raster-resource-upload";

export interface CapturedRasterResource {
  messages: PutResource[];
  pixels: ArrayBuffer;
  replay: ArrayBuffer;
}

export interface RasterFrameCapture {
  references: string[];
  resources: CapturedRasterResource[];
}

/** Diagnostic-only capture of installed textures; ordinary preview never calls this path. */
export async function captureRasterResources(
  device: GPUDevice,
  owners: Iterable<MediaResource>,
  scope: string,
  known: Map<string, string>,
  createBindGroup: (texture: GPUTexture) => GPUBindGroup,
): Promise<RasterFrameCapture> {
  const selected = [...owners].filter(
    (owner) => owner.mediaIdentity?.sample.kind === "raster" && owner.texture && owner.bindGroup,
  );
  const release = retainMediaResources(selected);
  const pool = new GpuFrameReadbackPool(device, "rgba8unorm-srgb", 1);
  const result: RasterFrameCapture = { references: [], resources: [] };
  const captured = new Map<string, string>();
  let totalBytes = 0;
  const read = async (texture: GPUTexture, width: number, height: number) => {
    const ticket = pool.reserve(width, height);
    try {
      const encoder = device.createCommandEncoder({ label: "Raster resource capture" });
      ticket.encode(encoder, texture);
      device.queue.submit([encoder.finish()]);
      return (await ticket.read()).pixels;
    } catch (error) {
      ticket.abort();
      throw error;
    }
  };
  try {
    for (const owner of selected) {
      const messages = mediaFrameMessages(owner, scope);
      const frame = messages[1];
      requirePlan(
        frame.kind === "media_frame" && owner.texture,
        "missing_resource",
        "Raster texture is absent",
      );
      const existing = known.get(frame.hash) ?? captured.get(frame.hash);
      if (existing) {
        result.references.push(existing);
        continue;
      }
      const { width, height } = frame.descriptor;
      totalBytes += width * height * 4;
      requirePlan(
        totalBytes <= 256 * 1024 * 1024 && known.size + captured.size < 65536,
        "resource_budget_exceeded",
        "Raster capture exceeds its bounded frame budget",
      );
      const original = await read(owner.texture, width, height);
      requirePlan(
        mediaFrameMessages(owner, scope)[1].hash === frame.hash,
        "resource_generation_mismatch",
        "Raster changed during capture",
      );
      const pixels = await createRasterPixels(frame, new Uint8Array(original));
      const registry = new FrameResourceRegistry({
        budget_bytes:
          pixels.bytes.length + new TextEncoder().encode(JSON.stringify(messages)).length,
        max_resources: 3,
      });
      for (const message of messages) await registry.apply(message);
      await registry.apply(pixels.message, pixels.bytes);
      const replay = uploadRasterResource(registry, pixels.message.hash, scope, {
        device,
        maximumDimension: device.limits.maxTextureDimension2D,
        maximumBytes: 256 * 1024 * 1024,
        label: "Decoded raster replay",
        createBindGroup,
      });
      try {
        requirePlan(
          replay.resource.texture,
          "missing_resource",
          "Decoded raster texture is absent",
        );
        const replayed = await read(replay.resource.texture, width, height);
        const view = new Uint8Array(replayed);
        requirePlan(
          view.length === pixels.bytes.length &&
            view.every((value, index) => value === pixels.bytes[index]),
          "resource_conflict",
          "Decoded raster GPU replay differs from captured pixels",
        );
        result.resources.push({
          messages: [...messages, pixels.message],
          pixels: original,
          replay: replayed,
        });
        result.references.push(pixels.message.hash);
        captured.set(frame.hash, pixels.message.hash);
      } finally {
        destroyMediaResource(replay.resource);
      }
    }
    for (const [frame, pixels] of captured) known.set(frame, pixels);
    result.references = [...new Set(result.references)];
    return result;
  } finally {
    pool.destroy();
    release();
  }
}
