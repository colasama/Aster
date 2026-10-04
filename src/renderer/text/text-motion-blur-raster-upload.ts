import { preparedRasterIdentity } from "../media/media-frame-identity";
import type { MediaResource } from "../media/media-resource";
import {
  type AcquiredTemporalTextRaster,
  TEXT_MOTION_BLUR_WEIGHT_STRIDE as WEIGHT_UNIFORM_STRIDE,
} from "./text-motion-blur-raster-input";

export interface TemporalTextUploadDestination {
  device: GPUDevice;
  sampleLayout: GPUBindGroupLayout;
  resolveLayout: GPUBindGroupLayout;
  mediaLayout: GPUBindGroupLayout;
  mediaSampler: GPUSampler;
  reuse?: { output: GPUTexture; bindGroup: GPUBindGroup };
}

/** Upload supplied canvases and allocate uniform slots without authoring-layer access. */
export function uploadTemporalTextRasters(
  prepared: AcquiredTemporalTextRaster,
  destination: TemporalTextUploadDestination,
) {
  const { width, height, pixelBytes } = prepared.scale;
  const { samples, rasters } = prepared;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > destination.device.limits.maxTextureDimension2D ||
    height > destination.device.limits.maxTextureDimension2D ||
    pixelBytes !== width * height * 4 ||
    samples.length !== rasters.length ||
    rasters.some((raster) => raster.width !== width || raster.height !== height)
  )
    throw new Error("Prepared temporal raster extents or sample count differ");
  const reuseOutput = destination.reuse !== undefined;
  let output = destination.reuse?.output;
  let accumulation: GPUTexture | undefined;
  let weights: GPUBuffer | undefined;
  let resolveBindGroup: GPUBindGroup | undefined;
  let bindGroup: GPUBindGroup | undefined;
  const sampleTextures: GPUTexture[] = [];
  const sampleBindGroups: GPUBindGroup[] = [];
  const sampleResources: MediaResource[] = [];
  try {
    output ??= destination.device.createTexture({
      label: `Temporal text output · ${prepared.label}`,
      size: [width, height],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    accumulation = destination.device.createTexture({
      label: `Temporal text linear accumulation · ${prepared.label}`,
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    weights =
      samples.length > 0
        ? destination.device.createBuffer({
            label: `Temporal text sample weights · ${prepared.label}`,
            size: samples.length * WEIGHT_UNIFORM_STRIDE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
        : undefined;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const texture = destination.device.createTexture({
        label: `Temporal text sample ${index + 1}/${samples.length} · ${prepared.label}`,
        size: [width, height],
        format: "rgba8unorm-srgb",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      sampleTextures.push(texture);
      sampleBindGroups.push(
        destination.device.createBindGroup({
          label: `Temporal text sample binding · ${prepared.sourceId} · ${sample.timeBucket}`,
          layout: destination.sampleLayout,
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: destination.mediaSampler },
            {
              binding: 2,
              resource: {
                buffer: weights as GPUBuffer,
                offset: index * WEIGHT_UNIFORM_STRIDE,
                size: 16,
              },
            },
          ],
        }),
      );
      const source = JSON.stringify([
        "temporal-text-sample-v1",
        prepared.source,
        index,
        sample.localTime,
      ]);
      const mediaIdentity = preparedRasterIdentity(
        prepared.sourceId,
        "text",
        source,
        prepared.bounds,
      );
      sampleResources.push({
        kind: "text",
        source,
        mediaIdentity,
        bindingGeneration: JSON.stringify([mediaIdentity, width, height]),
        texture,
        textureWidth: width,
        textureHeight: height,
        textureBytes: pixelBytes,
        bindGroup: sampleBindGroups[index],
        textBounds: { ...prepared.bounds },
      });
    }
    resolveBindGroup = destination.device.createBindGroup({
      label: `Temporal text resolve binding · ${prepared.sourceId}`,
      layout: destination.resolveLayout,
      entries: [{ binding: 0, resource: accumulation.createView() }],
    });
    bindGroup = destination.reuse
      ? destination.reuse.bindGroup
      : destination.device.createBindGroup({
          label: `Temporal text media binding · ${prepared.sourceId}`,
          layout: destination.mediaLayout,
          entries: [
            { binding: 0, resource: output.createView() },
            { binding: 1, resource: destination.mediaSampler },
          ],
        });
    for (let index = 0; index < sampleTextures.length; index += 1)
      destination.device.queue.copyExternalImageToTexture(
        { source: rasters[index].canvas },
        { texture: sampleTextures[index] },
        [width, height],
      );
  } catch (error) {
    for (const texture of sampleTextures) texture.destroy();
    accumulation?.destroy();
    if (!reuseOutput) output?.destroy();
    weights?.destroy();
    throw error;
  }
  if (!output || !accumulation || !resolveBindGroup || !bindGroup)
    throw new Error("Temporal text generation did not initialize its GPU resources");
  const transientBytes = pixelBytes * samples.length + pixelBytes * 2 + (weights?.size ?? 0);

  return {
    output,
    accumulation,
    weights,
    resolveBindGroup,
    bindGroup,
    sampleTextures,
    sampleBindGroups,
    sampleResources,
    sampleWeights: samples.map((sample) => sample.weight),
    transientBytes,
  };
}
