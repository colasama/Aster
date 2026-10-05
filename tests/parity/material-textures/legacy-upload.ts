/** Frozen normal-upload behavior extracted from 9121e2b; COPY_SRC is diagnostic only. */
export async function legacyNormalUpload(device: GPUDevice, blob: Blob): Promise<GPUTexture> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  try {
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture }, [
      bitmap.width,
      bitmap.height,
    ]);
    return texture;
  } finally {
    bitmap.close();
  }
}
