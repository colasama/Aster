import { sourceLocator } from "../../core/media/footage-source";
import type { Project } from "../../core/types";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import { rasterizeSvgToImageBitmap, SvgRasterCache } from "../../importers/svg-raster-cache";
import { readTemporalPassSlice } from "../frame-plan/temporal-pass-plan";
import type { FrameHeaderSlice } from "../frame-plan/types";
import { uploadImageRaster } from "../media/image-raster-upload";
import { preparePsdRaster } from "../media/imported-raster-preparation";
import { MediaBindingLease } from "../media/media-binding-lease";
import { preparedRasterIdentity } from "../media/media-frame-identity";
import { destroyMediaResource, type MediaResource } from "../media/media-resource";
import { MediaTextureCache } from "../media/media-texture-cache";
import { NativeRasterCaptureCache } from "../media/native-raster-capture-cache";
import type { RetainedRasterRequest } from "./retained-raster-types";

/** Retains the existing font/import raster boundary without invoking a scene or effect evaluator. */
export class RetainedRasterProvider {
  readonly #text: MediaTextureCache;
  readonly #images = new Map<string, MediaResource>();
  readonly #pixels = new NativeRasterCaptureCache();
  readonly #svg = new SvgRasterCache<ImageBitmap>({
    rasterize: rasterizeSvgToImageBitmap,
    dispose: (bitmap) => bitmap.close(),
    maxEntries: 12,
    maxBytes: 256 * 1024 * 1024,
  });
  #busy = false;
  #destroyed = false;

  constructor(
    readonly device: GPUDevice,
    readonly layout: GPUBindGroupLayout,
    readonly sampler: GPUSampler,
    readonly maximumImageBytes = 384 * 1024 * 1024,
  ) {
    this.#text = new MediaTextureCache(device, layout, sampler, () => {});
  }

  async acquire(
    project: Project,
    requests: readonly RetainedRasterRequest[],
    header: FrameHeaderSlice,
  ) {
    if (this.#busy || this.#destroyed || requests.length > 65536)
      throw new Error("Retained raster provider is not ready for this request");
    this.#busy = true;
    let textLease: MediaBindingLease | undefined;
    let imageLease: MediaBindingLease | undefined;
    try {
      const textIds = new Set<string>(),
        imageIds = new Set<string>();
      const previousTextBounds = Object.fromEntries(this.#text.snapshotTextBounds());
      this.#text.beginFrame(true);
      for (const request of requests) {
        const layer = project.compositions
          .find((c) => c.id === request.compositionId)
          ?.layers.find((l) => l.id === request.layerId);
        if (!layer || !request.instanceId || request.instanceId.length > 4096)
          throw new Error("Native raster address is absent from the loaded project");
        if (request.kind === "text") {
          if (
            layer.kind !== "text" ||
            ![request.sourceTime, request.frameRate, request.resolutionScale].every(
              Number.isFinite,
            ) ||
            request.frameRate <= 0 ||
            request.resolutionScale < 1 ||
            request.resolutionScale > 8
          )
            throw new Error("Native text raster request is invalid");
          this.#text.prepareText(
            layer,
            request.instanceId,
            request.sourceTime,
            request.frameRate,
            request.resolutionScale,
            request.exposure ?? undefined,
          );
          textIds.add(request.instanceId);
        } else {
          if (layer.sourceId !== request.sourceId)
            throw new Error("Native raster source binding differs");
          const source = project.sources.find((s) => s.id === request.sourceId);
          const runtime = mediaImportRuntime.get(request.sourceId);
          const locator = sourceLocator(source);
          if (
            !source ||
            !runtime ||
            !locator ||
            source.kind !== request.kind ||
            runtime.kind !== request.kind
          )
            throw new Error("Retained import is unavailable for native raster request");
          const maximumDimension = Math.min(8192, this.device.limits.maxTextureDimension2D);
          const destination = {
            device: this.device,
            label: `Native retained raster · ${request.sourceId}`,
            maximumDimension,
            maximumBytes: 256 * 1024 * 1024,
            createBindGroup: (texture: GPUTexture) => this.#binding(texture),
          };
          const previous = this.#images.get(request.instanceId);
          let resource: MediaResource;
          if (request.kind === "psd" && runtime.kind === "psd") {
            const prepared = preparePsdRaster(
              runtime,
              source,
              locator,
              maximumDimension,
              destination.maximumBytes,
            );
            if (previous?.source === prepared.source) {
              imageIds.add(request.instanceId);
              continue;
            }
            this.#admitImage(
              request.instanceId,
              prepared.pixels.width * prepared.pixels.height * 4,
            );
            resource = {
              source: prepared.source,
              kind: "image",
              mediaIdentity: prepared.identity,
              ...uploadImageRaster(prepared.pixels, destination),
            };
          } else if (request.kind === "svg" && runtime.kind === "svg") {
            const { width, height } = request;
            if (
              ![width, height].every(
                (n) => Number.isSafeInteger(n) && n > 0 && n <= maximumDimension,
              )
            )
              throw new Error("Native SVG target exceeds device bounds");
            const generation = JSON.stringify([source.contentIdentity, width, height]);
            const identity = JSON.stringify([locator, generation]);
            if (previous?.source === identity) {
              imageIds.add(request.instanceId);
              continue;
            }
            this.#admitImage(request.instanceId, width * height * 4);
            const bitmap = await this.#svg.get(source.contentIdentity, runtime.parsed, {
              width,
              height,
              requestedWidth: width,
              requestedHeight: height,
              downsampleScale: 1,
            });
            resource = {
              source: identity,
              kind: "image",
              mediaIdentity: preparedRasterIdentity(source.id, "svg", generation, {
                x: 0,
                y: 0,
                width,
                height,
              }),
              ...uploadImageRaster(
                { kind: "bitmap", bitmap, closeAfterUpload: false },
                destination,
              ),
            };
          } else throw new Error("Unsupported retained raster request");
          this.#images.set(request.instanceId, resource);
          destroyMediaResource(previous);
          imageIds.add(request.instanceId);
        }
      }
      if ([...textIds].some((id) => imageIds.has(id)))
        throw new Error("Conflicting native raster instances");
      await this.#text.waitForFrameResources();
      textLease = this.#text.acquireFrameBindings([...textIds], header.snapshot_scope);
      imageLease = new MediaBindingLease(
        [...imageIds].map((instanceId) => ({
          instanceId,
          resource: this.#images.get(instanceId),
          binding: this.#images.get(instanceId)?.bindGroup,
        })),
        header.snapshot_scope,
      );
      const temporal = this.#text.planTemporalPasses(header, textLease);
      const encoder = this.device.createCommandEncoder({
        label: "Retained native raster resources",
      });
      this.#text.flush(encoder, header, temporal);
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      const resources = [...textLease.resourceMessages, ...imageLease.resourceMessages];
      const frames = new Map(
        resources.filter((r) => r.kind === "media_frame").map((r) => [r.hash, r]),
      );
      const textFrames = new Set(
        textLease.resourceMessages.filter((r) => r.kind === "media_frame").map((r) => r.hash),
      );
      const pixels = await this.#pixels.capture(
        this.device,
        {
          textureForHash: (hash) =>
            (textFrames.has(hash) ? textLease : imageLease)?.textureForHash(hash) as GPUTexture,
        },
        [...frames.values()],
      );
      const bindings = Object.fromEntries(
        [...textIds]
          .map((id) => [id, textLease?.hashFor(id)])
          .concat([...imageIds].map((id) => [id, imageLease?.hashFor(id)])),
      );
      const textBounds = Object.fromEntries(
        [...textIds].flatMap((id) => {
          const bounds = this.#text.textBounds(id);
          return bounds ? [[id, { ...bounds }]] : [];
        }),
      );
      this.#text.submitted();
      this.#text.sweep(textIds);
      for (const [id, resource] of this.#images)
        if (!imageIds.has(id)) {
          destroyMediaResource(resource);
          this.#images.delete(id);
        }
      return {
        bindings,
        resources,
        pixels,
        textBounds,
        previousTextBounds,
        temporal: temporal.map((slice) => {
          const p = readTemporalPassSlice(slice);
          return { width: p.width, height: p.height, output: p.output, samples: p.samples };
        }),
      };
    } catch (error) {
      this.#text.abortFrame();
      throw error;
    } finally {
      textLease?.release();
      imageLease?.release();
      this.#busy = false;
    }
  }

  #binding(texture: GPUTexture) {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
  }

  #admitImage(instance: string, bytes: number) {
    const retained = [...this.#images].reduce(
      (total, [id, resource]) => total + (id === instance ? 0 : (resource.textureBytes ?? 0)),
      0,
    );
    if (retained + bytes > this.maximumImageBytes)
      throw new Error("Native retained images exceed byte budget");
  }

  destroy() {
    if (this.#busy) throw new Error("Cannot destroy retained rasters during acquisition");
    this.#destroyed = true;
    this.#text.destroy();
    this.#svg.clear();
    this.#pixels.clear();
    for (const resource of this.#images.values()) destroyMediaResource(resource);
    this.#images.clear();
  }
}
