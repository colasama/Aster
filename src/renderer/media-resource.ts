export interface MediaResource {
  source: string;
  kind: "image" | "video" | "text";
  texture?: GPUTexture;
  textureBytes?: number;
  bindGroup?: GPUBindGroup;
  video?: HTMLVideoElement;
  videoCanvas?: HTMLCanvasElement;
  videoContext?: CanvasRenderingContext2D;
  lastUploadedTime?: number;
  uploadErrorReported?: boolean;
}

export function reportVideoUploadError(resource: MediaResource, error: unknown): void {
  if (resource.uploadErrorReported) return;
  resource.uploadErrorReported = true;
  if (resource.video)
    resource.video.dataset.gpuError = error instanceof Error ? error.message : String(error);
  console.warn("Aster video frame upload is waiting for a decoded frame", error);
}

export function destroyMediaResource(resource?: MediaResource): void {
  if (!resource) return;
  resource.video?.pause();
  resource.videoCanvas?.remove();
  if (resource.video) {
    resource.video.removeAttribute("src");
    resource.video.load();
    resource.video.remove();
  }
  resource.texture?.destroy();
}

export function sweepMediaResources(
  resources: Map<string, MediaResource>,
  activeLayerIds: ReadonlySet<string>,
): void {
  for (const [layerId, resource] of resources) {
    if (activeLayerIds.has(layerId)) continue;
    destroyMediaResource(resource);
    resources.delete(layerId);
  }
}

export function mediaTextureBytes(resources: ReadonlyMap<string, MediaResource>): number {
  let bytes = 0;
  for (const resource of resources.values()) bytes += resource.textureBytes ?? 0;
  return bytes;
}
