import { logger } from "../../core/logger";
import { FramePlanError } from "../frame-plan/types";
import type { TextRasterBounds } from "../text/text-raster-bounds";
import type { PreparedMediaIdentity } from "./media-frame-identity";
import type { VideoExternalUpload } from "./video-external-upload";

export interface MediaResource {
  mediaIdentity?: PreparedMediaIdentity;
  /** Installed pixel generation, separate from a lookup key that may advance without upload. */
  bindingGeneration?: string;
  source: string;
  kind: "image" | "video" | "text";
  texture?: GPUTexture;
  textureBytes?: number;
  textureWidth?: number;
  textureHeight?: number;
  bindGroup?: GPUBindGroup;
  textBounds?: TextRasterBounds;
  textSignature?: string;
  video?: HTMLVideoElement;
  videoCanvas?: HTMLCanvasElement;
  videoContext?: CanvasRenderingContext2D;
  videoExternalUpload?: VideoExternalUpload;
  lastUploadedTime?: number;
  uploadErrorReported?: boolean;
}

interface MediaResourceLifetime {
  pins: number;
  retired: boolean;
  destroyed: boolean;
}

const lifetimes = new WeakMap<MediaResource, MediaResourceLifetime>();

/** Acquires every owner atomically before encoding commands that reference its texture. */
export function retainMediaResources(resources: readonly MediaResource[]): () => void {
  const owners = [...new Set(resources)];
  const states = owners.map((resource) => {
    let state = lifetimes.get(resource);
    if (!state) {
      state = { pins: 0, retired: false, destroyed: false };
      lifetimes.set(resource, state);
    }
    if (state.retired)
      throw new FramePlanError(
        "missing_resource",
        "Media resource was retired before frame acquisition",
      );
    return state;
  });
  for (const state of states) state.pins += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.forEach((resource, index) => {
      states[index].pins -= 1;
      if (states[index].retired) destroyMediaResource(resource);
    });
  };
}

export function mediaResourceRetired(resource: MediaResource): boolean {
  return lifetimes.get(resource)?.retired === true;
}

/** Pinned generations cannot be overwritten while a frame still holds their binding. */
export function mediaResourcePinned(resource: MediaResource): boolean {
  return (lifetimes.get(resource)?.pins ?? 0) > 0;
}

export function reportVideoUploadError(resource: MediaResource, error: unknown): void {
  if (resource.uploadErrorReported) return;
  resource.uploadErrorReported = true;
  if (resource.video)
    resource.video.dataset.gpuError = error instanceof Error ? error.message : String(error);
  logger.warn("webgpu", "video_frame_upload_waiting", undefined, error);
}

export function destroyMediaResource(resource?: MediaResource): void {
  if (!resource) return;
  let state = lifetimes.get(resource);
  if (!state) {
    state = { pins: 0, retired: false, destroyed: false };
    lifetimes.set(resource, state);
  }
  state.retired = true;
  if (state.pins > 0 || state.destroyed) return;
  state.destroyed = true;
  resource.videoExternalUpload?.destroy();
  resource.video?.pause();
  if (resource.videoCanvas) {
    resource.videoCanvas.width = 1;
    resource.videoCanvas.height = 1;
  }
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

export function mediaTextureBytes(
  resources: ReadonlyMap<string, MediaResource>,
  retained: Iterable<MediaResource> = [],
): number {
  let bytes = 0;
  for (const resource of new Set([...resources.values(), ...retained]))
    bytes += resource.textureBytes ?? 0;
  return bytes;
}

export function mediaTextureExtent(resource: MediaResource): [number, number] | undefined {
  const width = resource.textureWidth;
  const height = resource.textureHeight;
  if (!width || !height) return undefined;
  return [width, height];
}
