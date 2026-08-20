const PROBE_BYTES_PER_ROW = 256;
const PROBE_PATCH_COUNT = 3;
const PROBE_PATCH_SIZE = 2;
const PROBE_TIMEOUT_MS = 900;
const MAX_PROBE_TIMEOUT_MS = 2_000;
const MAX_PROBE_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 120;
const MIN_REFERENCE_SIGNAL = 16;
const MIN_REFERENCE_SIGNAL_CHANNELS = 3;

export type VideoExternalUploadMode = "validating" | "direct" | "fallback";

export interface VideoExternalUploadStatus {
  mode: VideoExternalUploadMode;
  reason: string;
}

export interface VideoProbeResult {
  matches: boolean;
  reason: string;
  meanError?: number;
  maximumError?: number;
}

export interface VideoProbePatch {
  sourceX: number;
  sourceY: number;
  destinationY: number;
  size: number;
}

type VideoProbe = (
  device: GPUDevice,
  video: HTMLVideoElement,
  width: number,
  height: number,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<VideoProbeResult>;

interface VideoExternalUploadOptions {
  onStatus?: (status: VideoExternalUploadStatus) => void;
  now?: () => number;
  probe?: VideoProbe;
  retryBackoffMs?: number;
  timeoutMs?: number;
}

/**
 * Enables direct external-image uploads only after a bounded GPU readback agrees with a tiny
 * Canvas2D reference. This is a low-copy upload path, not a zero-copy rendering claim.
 */
export class VideoExternalUpload {
  readonly #device: GPUDevice;
  readonly #video: HTMLVideoElement;
  readonly #copySource: GPUCopyExternalImageSourceInfo;
  readonly #copyDestination: GPUCopyExternalImageDestInfo;
  readonly #copyExtent: [number, number];
  readonly #width: number;
  readonly #height: number;
  readonly #onStatus?: (status: VideoExternalUploadStatus) => void;
  readonly #probe: VideoProbe;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #retryBackoffMs: number;
  readonly #abortController = new AbortController();
  #status: VideoExternalUploadStatus = {
    mode: "validating",
    reason: "runtime-validation-pending",
  };
  #started = false;
  #destroyed = false;
  #probePending = false;
  #permanentFallback = false;
  #attempts = 0;
  #lastProbeMediaTime?: number;
  #nextRetryAt = 0;

  constructor(
    device: GPUDevice,
    video: HTMLVideoElement,
    texture: GPUTexture,
    width: number,
    height: number,
    options: VideoExternalUploadOptions = {},
  ) {
    this.#device = device;
    this.#video = video;
    this.#copySource = { source: video };
    this.#copyDestination = { texture };
    this.#copyExtent = [width, height];
    this.#width = width;
    this.#height = height;
    this.#onStatus = options.onStatus;
    this.#probe = options.probe ?? probeVideoExternalUpload;
    this.#now = options.now ?? (() => performance.now());
    this.#retryBackoffMs = Math.max(
      1,
      Math.trunc(options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS),
    );
    this.#timeoutMs = Math.min(
      MAX_PROBE_TIMEOUT_MS,
      Math.max(1, Math.trunc(options.timeoutMs ?? PROBE_TIMEOUT_MS)),
    );
  }

  get status(): VideoExternalUploadStatus {
    return this.#status;
  }

  start(): void {
    if (this.#started || this.#destroyed) return;
    this.#started = true;
    this.#publishStatus(this.#status);
    this.#runProbe(this.#currentMediaTime());
  }

  copyFrame(): boolean {
    if (this.#destroyed) return false;
    if (this.#status.mode !== "direct") {
      this.#retryProbeIfReady();
      return false;
    }
    if (this.#video.videoWidth !== this.#width || this.#video.videoHeight !== this.#height) {
      this.#permanentFallback = true;
      this.#publishStatus({ mode: "fallback", reason: "decoded-extent-changed;permanent" });
      return false;
    }
    try {
      this.#device.queue.copyExternalImageToTexture(
        this.#copySource,
        this.#copyDestination,
        this.#copyExtent,
      );
      return true;
    } catch (error) {
      this.#permanentFallback = true;
      this.#publishStatus({
        mode: "fallback",
        reason: `direct-copy-failed:${probeFailureReason(error)}`,
      });
      return false;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#abortController.abort();
  }

  #publishStatus(status: VideoExternalUploadStatus): void {
    if (this.#destroyed) return;
    this.#status = status;
    this.#onStatus?.(status);
  }

  #runProbe(mediaTime: number): void {
    if (
      this.#destroyed ||
      this.#probePending ||
      this.#permanentFallback ||
      this.#attempts >= MAX_PROBE_ATTEMPTS
    )
      return;
    this.#probePending = true;
    this.#attempts += 1;
    this.#lastProbeMediaTime = mediaTime;
    if (this.#attempts > 1)
      this.#publishStatus({
        mode: "validating",
        reason: `runtime-validation-retry:${this.#attempts}/${MAX_PROBE_ATTEMPTS}`,
      });
    let work: Promise<VideoProbeResult>;
    try {
      work = this.#probe(
        this.#device,
        this.#video,
        this.#width,
        this.#height,
        this.#abortController.signal,
        this.#timeoutMs,
      );
    } catch (error) {
      this.#completeProbe({ matches: false, reason: probeFailureReason(error) });
      return;
    }
    void work.then(
      (result) => this.#completeProbe(result),
      (error: unknown) =>
        this.#completeProbe({ matches: false, reason: probeFailureReason(error) }),
    );
  }

  #completeProbe(result: VideoProbeResult): void {
    this.#probePending = false;
    if (this.#destroyed) return;
    if (result.matches) {
      this.#publishStatus({ mode: "direct", reason: result.reason });
      return;
    }
    const retriable = isRetriableProbeFailure(result.reason);
    if (retriable && this.#attempts < MAX_PROBE_ATTEMPTS) {
      const backoff = this.#retryBackoffMs * 2 ** (this.#attempts - 1);
      this.#nextRetryAt = this.#now() + backoff;
      this.#publishStatus({
        mode: "fallback",
        reason: `${result.reason};retry-pending:${this.#attempts}/${MAX_PROBE_ATTEMPTS}`,
      });
      return;
    }
    this.#permanentFallback = true;
    this.#publishStatus({
      mode: "fallback",
      reason: `${result.reason};${retriable ? "retry-exhausted" : "permanent"}`,
    });
  }

  #retryProbeIfReady(): void {
    if (
      this.#permanentFallback ||
      this.#probePending ||
      this.#attempts >= MAX_PROBE_ATTEMPTS ||
      this.#now() < this.#nextRetryAt
    )
      return;
    const mediaTime = this.#currentMediaTime();
    if (
      this.#lastProbeMediaTime !== undefined &&
      Math.abs(mediaTime - this.#lastProbeMediaTime) <= 1 / 1_000
    )
      return;
    this.#runProbe(mediaTime);
  }

  #currentMediaTime(): number {
    return Number.isFinite(this.#video.currentTime) ? this.#video.currentTime : 0;
  }
}

export function planVideoProbePatches(width: number, height: number): VideoProbePatch[] {
  const boundedWidth = Math.max(1, Math.trunc(width));
  const boundedHeight = Math.max(1, Math.trunc(height));
  const size = Math.min(PROBE_PATCH_SIZE, boundedWidth, boundedHeight);
  const anchors = [0.2, 0.5, 0.8] as const;
  return anchors.map((anchor, index) => ({
    sourceX: Math.min(
      boundedWidth - size,
      Math.max(0, Math.floor(boundedWidth * anchor - size / 2)),
    ),
    sourceY: Math.min(
      boundedHeight - size,
      Math.max(0, Math.floor(boundedHeight * (1 - anchor) - size / 2)),
    ),
    destinationY: index * size,
    size,
  }));
}

export function compareVideoProbeSamples(
  reference: Uint8Array,
  gpuPaddedRows: Uint8Array,
  width: number,
  height: number,
  bytesPerRow = PROBE_BYTES_PER_ROW,
): VideoProbeResult {
  if (
    width < 1 ||
    height < 1 ||
    width > PROBE_PATCH_SIZE ||
    height > PROBE_PATCH_COUNT * PROBE_PATCH_SIZE ||
    bytesPerRow < width * 4 ||
    reference.byteLength !== width * height * 4 ||
    gpuPaddedRows.byteLength < bytesPerRow * height
  ) {
    return { matches: false, reason: "invalid-probe-layout" };
  }

  let totalError = 0;
  let maximumError = 0;
  let referenceMaximum = 0;
  let referenceMinimum = 255;
  let signalError = 0;
  let signalChannels = 0;
  let comparedChannels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const referenceOffset = (y * width + x) * 4;
      const gpuOffset = y * bytesPerRow + x * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const referenceValue = reference[referenceOffset + channel] ?? 0;
        const gpuValue = gpuPaddedRows[gpuOffset + channel] ?? 0;
        const error = Math.abs(referenceValue - gpuValue);
        referenceMaximum = Math.max(referenceMaximum, referenceValue);
        referenceMinimum = Math.min(referenceMinimum, referenceValue);
        maximumError = Math.max(maximumError, error);
        totalError += error;
        comparedChannels += 1;
        if (referenceValue >= MIN_REFERENCE_SIGNAL) {
          signalError += error;
          signalChannels += 1;
        }
      }
    }
  }
  if (
    signalChannels < MIN_REFERENCE_SIGNAL_CHANNELS ||
    (referenceMaximum < MIN_REFERENCE_SIGNAL * 2 &&
      referenceMaximum - referenceMinimum < MIN_REFERENCE_SIGNAL / 2)
  ) {
    return { matches: false, reason: "reference-frame-inconclusive" };
  }
  const meanError = totalError / Math.max(1, comparedChannels);
  const signalMeanError = signalError / Math.max(1, signalChannels);
  const matches = maximumError <= 32 && meanError <= 8 && signalMeanError <= 8;
  return {
    matches,
    reason: matches ? "gpu-readback-matched-reference" : "gpu-readback-mismatch",
    meanError,
    maximumError,
  };
}

export async function probeVideoExternalUpload(
  device: GPUDevice,
  video: HTMLVideoElement,
  width: number,
  height: number,
  signal: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VideoProbeResult> {
  if (signal.aborted) throw new DOMException("Video upload validation was cancelled", "AbortError");
  const patches = planVideoProbePatches(width, height);
  const sampleWidth = patches[0]?.size ?? 1;
  const sampleHeight = patches.length * sampleWidth;
  const reference = readVideoReference(video, patches, sampleWidth, sampleHeight);
  const texture = device.createTexture({
    label: "Video external upload validation texture",
    size: [sampleWidth, sampleHeight],
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const buffer = device.createBuffer({
    label: "Bounded video external upload validation readback",
    size: PROBE_BYTES_PER_ROW * sampleHeight,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let mapped = false;
  let scopeOpen = true;
  device.pushErrorScope("validation");
  try {
    for (const patch of patches) {
      device.queue.copyExternalImageToTexture(
        { source: video, origin: [patch.sourceX, patch.sourceY] },
        { texture, origin: [0, patch.destinationY] },
        [patch.size, patch.size],
      );
    }
    const encoder = device.createCommandEncoder({ label: "Video external upload validation" });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow: PROBE_BYTES_PER_ROW, rowsPerImage: sampleHeight },
      [sampleWidth, sampleHeight],
    );
    device.queue.submit([encoder.finish()]);
    const validation = device.popErrorScope();
    scopeOpen = false;
    const [, validationError] = await waitForBoundedProbe(
      Promise.all([buffer.mapAsync(GPUMapMode.READ), validation]),
      signal,
      timeoutMs,
    );
    if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
    mapped = true;
    const gpuBytes = new Uint8Array(buffer.getMappedRange().slice(0));
    return compareVideoProbeSamples(
      reference,
      gpuBytes,
      sampleWidth,
      sampleHeight,
      PROBE_BYTES_PER_ROW,
    );
  } finally {
    if (scopeOpen) void device.popErrorScope().catch(() => undefined);
    if (mapped) buffer.unmap();
    buffer.destroy();
    texture.destroy();
  }
}

function readVideoReference(
  video: HTMLVideoElement,
  patches: readonly VideoProbePatch[],
  width: number,
  height: number,
): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("Canvas2D reference sampling is unavailable");
  for (const patch of patches) {
    context.drawImage(
      video,
      patch.sourceX,
      patch.sourceY,
      patch.size,
      patch.size,
      0,
      patch.destinationY,
      patch.size,
      patch.size,
    );
  }
  return new Uint8Array(context.getImageData(0, 0, width, height).data);
}

function waitForBoundedProbe<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException("Video upload validation was cancelled", "AbortError")));
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Video upload validation timed out"))),
      Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(1, Math.trunc(timeoutMs))),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function probeFailureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "validation-cancelled";
  if (error instanceof Error && error.message.includes("timed out")) return "validation-timeout";
  const detail =
    error instanceof Error
      ? error.message.replace(/\s+/g, " ").trim().slice(0, 160)
      : "unknown-error";
  if (error instanceof Error && error.message.includes("validation failed"))
    return `webgpu-validation-error:${detail}`;
  return `validation-unavailable:${detail}`;
}

function isRetriableProbeFailure(reason: string): boolean {
  return (
    reason === "reference-frame-inconclusive" ||
    reason === "validation-timeout" ||
    reason.startsWith("validation-unavailable:")
  );
}
