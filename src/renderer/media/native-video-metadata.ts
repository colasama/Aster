import { abortError } from "./media-loading";
import type { VideoResourcePreparation } from "./video-resource-preparation";

/** Native plan capture needs a source clock and extent, never browser-decoded file pixels. */
export function prepareNativeVideoMetadata(options: VideoResourcePreparation): Promise<void> {
  const { resource } = options;
  const video = document.createElement("video");
  video.preload = "metadata";
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.src = resource.source;
  resource.video = video;
  options.updateTarget();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("error", failed);
      resource.cancelVideoPreparation = undefined;
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(new Error(video.error?.message || "Video metadata unavailable"));
    const ready = () => {
      if (!options.isCurrent()) {
        finish(abortError("Video metadata generation was replaced"));
        return;
      }
      try {
        const width = video.videoWidth,
          height = video.videoHeight;
        if (
          !Number.isFinite(video.duration) ||
          video.duration <= 0 ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width <= 0 ||
          height <= 0 ||
          !options.validSize(width, height)
        )
          throw new Error("Native video metadata exceeds limits");
        // A real, extent-matched handle satisfies planning bindings only. Pixel access is
        // rejected by the registry, and a TS fallback creates a fresh decoded generation.
        resource.texture = options.device.createTexture({
          label: "Native video planning extent",
          size: [width, height],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        resource.textureWidth = width;
        resource.textureHeight = height;
        resource.textureBytes = width * height * 4;
        resource.bindGroup = options.createBinding(resource.texture, "Native video plan binding");
        options.updateTarget();
        finish();
        options.invalidate();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    resource.cancelVideoPreparation = () => finish(abortError("Video metadata capture cancelled"));
    video.addEventListener("loadedmetadata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.load();
  });
}
