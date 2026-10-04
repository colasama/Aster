import { decodeRasterPixels } from "../frame-plan/raster-resource";
import type { FrameResourceRegistry } from "../frame-plan/resources";
import { type ImageRasterDestination, uploadImageRaster } from "./image-raster-upload";
import type { MediaResource } from "./media-resource";

/** Install decoded transport pixels; shaping, SVG parsing and PSD decoding are absent here. */
export function uploadRasterResource(
  registry: FrameResourceRegistry,
  pixelHash: string,
  scope: string,
  destination: ImageRasterDestination,
) {
  const raster = decodeRasterPixels(registry, pixelHash, scope);
  const uploaded = uploadImageRaster(
    {
      kind: "rgba",
      bytes: new Uint8ClampedArray(
        raster.bytes.buffer,
        raster.bytes.byteOffset,
        raster.bytes.byteLength,
      ),
      width: raster.width,
      height: raster.height,
      layout: { offset: 0, bytesPerRow: raster.width * 4, rowsPerImage: raster.height },
    },
    destination,
  );
  const resource: MediaResource = {
    ...uploaded,
    source: raster.frameHash,
    bindingGeneration: raster.frameHash,
    kind: raster.identity.sample.origin === "text" ? "text" : "image",
    mediaIdentity: raster.identity,
    textBounds: raster.identity.sample.origin === "text" ? raster.bounds : undefined,
  };
  return { resource, messages: raster.messages, frameHash: raster.frameHash };
}
