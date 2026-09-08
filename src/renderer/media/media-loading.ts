import { computeSvgRasterTarget } from "../../importers/svg-raster-cache";
import { MAX_MEDIA_TEXTURE_BYTES } from "./media-texture-cache";

export function hiddenMediaStyle(top: number): Partial<CSSStyleDeclaration> {
  return {
    height: "1px",
    left: "0",
    opacity: "0.001",
    pointerEvents: "none",
    position: "fixed",
    top: `${top}px`,
    width: "1px",
  };
}

function bucketSvgTarget(displayWidth: number, displayHeight: number, maximumDimension: number) {
  const largest = Math.max(1, displayWidth, displayHeight);
  const bucketedLargest = Math.min(
    maximumDimension,
    1.25 ** Math.ceil(Math.log(largest) / Math.log(1.25)),
  );
  const scale = bucketedLargest / largest;
  return computeSvgRasterTarget({
    displayWidth: displayWidth * scale,
    displayHeight: displayHeight * scale,
    resolutionScale: 1,
    maxTextureDimension: maximumDimension,
    maxPixels: MAX_MEDIA_TEXTURE_BYTES / 4,
  });
}

export function svgPreviewRasterTarget(
  displayWidth: number,
  displayHeight: number,
  resolutionScale: number,
  maximumDimension: number,
) {
  const scale = Number.isFinite(resolutionScale) ? Math.max(1, resolutionScale) : 1;
  return bucketSvgTarget(displayWidth * scale, displayHeight * scale, maximumDimension);
}

export function remainingTimeout(started: number, timeoutMs: number): number {
  const bounded = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 10_000;
  return Math.max(0, bounded - (performance.now() - started));
}

export function waitWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  if (timeoutMs <= 0) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(abortError(signal?.reason));
    const timeout = setTimeout(() => finish(new Error(message)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    task.then((value) => finish(undefined, value), finish);
  });
}

export function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "Frame resource wait was aborted");
  error.name = "AbortError";
  return error;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
