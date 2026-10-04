import { requirePlan } from "../frame-plan/canonical";
import type { PreparedTextRaster } from "../text/text-raster-acquisition";
import { destroyMediaResource, type MediaResource } from "./media-resource";

export interface TextRasterUploadDestination {
  device: GPUDevice;
  textureLabel: string;
  createBindGroup(texture: GPUTexture): GPUBindGroup;
}

/** Uploads supplied pixels and bounds without evaluating text, fonts, or animation. */
export function uploadTextRaster(
  prepared: PreparedTextRaster,
  existing: MediaResource | undefined,
  destination: TextRasterUploadDestination,
): MediaResource {
  if (prepared.kind === "retained") {
    requirePlan(existing?.kind === "text", "missing_resource", "Retained text raster is absent");
    existing.source = prepared.source;
    return existing;
  }
  const { raster, source, signature } = prepared;
  const reusable =
    existing?.kind === "text" &&
    existing.texture &&
    existing.textureWidth === raster.width &&
    existing.textureHeight === raster.height;
  const texture =
    (reusable ? existing.texture : undefined) ??
    destination.device.createTexture({
      label: destination.textureLabel,
      size: [raster.width, raster.height],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  let bindGroup: GPUBindGroup | undefined;
  try {
    destination.device.queue.copyExternalImageToTexture({ source: raster.canvas }, { texture }, [
      raster.width,
      raster.height,
    ]);
    bindGroup = reusable ? existing.bindGroup : destination.createBindGroup(texture);
  } catch (error) {
    if (!reusable) texture.destroy();
    throw error;
  }
  if (reusable) {
    existing.source = source;
    existing.textSignature = signature;
    existing.textBounds = raster.bounds && { ...raster.bounds };
    return existing;
  }
  const resource: MediaResource = {
    source,
    kind: "text",
    texture,
    textureWidth: raster.width,
    textureHeight: raster.height,
    textureBytes: raster.width * raster.height * 4,
    textBounds: raster.bounds && { ...raster.bounds },
    textSignature: signature,
    bindGroup,
  };
  destroyMediaResource(existing);
  return resource;
}
