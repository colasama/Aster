import type { MediaResource } from "./media-resource";

export type PreparedImagePixels =
  | { kind: "bitmap"; bitmap: ImageBitmap; closeAfterUpload: boolean }
  | {
      kind: "rgba";
      bytes: Uint8ClampedArray;
      width: number;
      height: number;
      layout: { offset: number; bytesPerRow: number; rowsPerImage: number };
    };

export interface ImageRasterDestination {
  device: GPUDevice;
  label: string;
  maximumDimension: number;
  maximumBytes: number;
  createBindGroup(texture: GPUTexture): GPUBindGroup;
}

/** Consumes prepared pixels without decoding, layer evaluation, or source discovery. */
export function uploadImageRaster(
  pixels: PreparedImagePixels,
  destination: ImageRasterDestination,
): Pick<
  MediaResource,
  "texture" | "textureWidth" | "textureHeight" | "textureBytes" | "bindGroup"
> {
  const { width, height } = pixels.kind === "bitmap" ? pixels.bitmap : pixels;
  let texture: GPUTexture | undefined;
  try {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > destination.maximumDimension ||
      height > destination.maximumDimension ||
      width * height * 4 > destination.maximumBytes
    )
      throw new Error("Decoded media exceeds the GPU texture limits");
    if (pixels.kind === "rgba") {
      const { offset, bytesPerRow, rowsPerImage } = pixels.layout;
      if (
        ![offset, bytesPerRow, rowsPerImage].every(Number.isSafeInteger) ||
        offset < 0 ||
        offset % 4 !== 0 ||
        bytesPerRow % 4 !== 0 ||
        bytesPerRow < width * 4 ||
        rowsPerImage < height ||
        offset + (height - 1) * bytesPerRow + width * 4 > pixels.bytes.byteLength
      )
        throw new Error("Prepared RGBA raster has an invalid byte layout");
    }
    texture = destination.device.createTexture({
      label: destination.label,
      size: [width, height],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        (pixels.kind === "bitmap" ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
    });
    if (pixels.kind === "bitmap") {
      destination.device.queue.copyExternalImageToTexture({ source: pixels.bitmap }, { texture }, [
        width,
        height,
      ]);
    } else {
      destination.device.queue.writeTexture({ texture }, pixels.bytes, pixels.layout, [
        width,
        height,
      ]);
    }
    return {
      texture,
      textureWidth: width,
      textureHeight: height,
      textureBytes: width * height * 4,
      bindGroup: destination.createBindGroup(texture),
    };
  } catch (error) {
    texture?.destroy();
    throw error;
  } finally {
    if (pixels.kind === "bitmap" && pixels.closeAfterUpload) pixels.bitmap.close();
  }
}
