import {
  type FrameRenderSessionOptions,
  openFrameRenderSession,
} from "../core/rendering/render-export";
import type { Project } from "../core/types";
import type { RawFramePixelFormat } from "../renderer/gpu/frame-readback";
import {
  blobToBase64,
  type ContactSheet,
  type ContactSheetRequest,
  composeContactSheet,
  contactSheetTimes,
  formatSheetTime,
} from "./contact-sheet";
import { type PreviewOptions, parsePreviewOptions, previewCropPixels } from "./preview-options";

const AGENT_PREVIEW_MAX_DIMENSION = 384;
const AGENT_PREVIEW_MAX_ENCODED_BYTES = 8 * 1024 * 1024;

export interface AgentPreviewMeasurements {
  averageLuminance: number;
  minimumLuminance: number;
  maximumLuminance: number;
  visiblePixelRatio: number;
  emptyFrame: boolean;
  differenceFromPrevious?: number;
}

export interface AgentRenderedPreviewFrame {
  time: number;
  renderId: string;
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
  measurements: AgentPreviewMeasurements;
}

export interface AgentContactSheet extends ContactSheet {
  samples: Array<{ time: number } & AgentPreviewMeasurements>;
}

/** Renders many small samples of the staged project into one labeled image. */
export async function renderAgentContactSheet(
  project: Project,
  request: ContactSheetRequest,
  signal: AbortSignal,
  input: PreviewOptions = {},
): Promise<AgentContactSheet> {
  const options = parsePreviewOptions(input);
  project = isolatePreviewLayers(project, options);
  const composition = project.compositions.find((item) => item.id === project.activeCompositionId);
  if (!composition) throw new Error("Preview composition is unavailable");
  const times = contactSheetTimes(request, [0, composition.duration]);
  if (times.some((time) => time < 0 || time > composition.duration))
    throw new Error("Contact sheet times must stay inside the composition");
  const cellWidth = request.cellWidth ?? 320;
  const aspect = composition.height / composition.width;
  const session = await openPreviewSession(
    { project, maxDimension: Math.max(64, Math.round(cellWidth * Math.max(1, aspect))) },
    signal,
  );
  const crop = previewCropPixels(session.width, session.height, options.crop);
  const cells = [];
  const samples: AgentContactSheet["samples"] = [];
  let previousPixels: Uint8ClampedArray | undefined;
  try {
    for (const time of times) {
      if (signal.aborted) throw new Error("Agent preview render was cancelled");
      const raw = await session.renderRawFrame(time);
      const fullPixels = normalizeRgbaPixels(raw.pixels, raw.pixelFormat);
      const pixels = options.crop ? cropPixels(fullPixels, session.width, crop) : fullPixels;
      samples.push({ time, ...measurePreviewPixels(pixels, previousPixels) });
      cells.push({
        time,
        label: formatSheetTime(time),
        image: new ImageData(new Uint8ClampedArray(pixels), crop.width, crop.height),
      });
      previousPixels = pixels;
    }
  } finally {
    session.close();
  }
  return { ...(await composeContactSheet(cells, request)), samples };
}

function isolatePreviewLayers(project: Project, options: PreviewOptions): Project {
  if (!options.layerIds) return project;
  const isolated = structuredClone(project);
  const composition = isolated.compositions.find(
    (item) => item.id === isolated.activeCompositionId,
  );
  if (
    !composition ||
    options.layerIds.some((id) => !composition.layers.some((layer) => layer.id === id))
  )
    throw new Error("Preview isolation references an unknown layer");
  for (const layer of composition.layers) layer.solo = options.layerIds.includes(layer.id);
  return isolated;
}

export async function renderAgentPreview(
  project: Project,
  times: readonly number[],
  signal: AbortSignal,
  input: PreviewOptions = {},
): Promise<AgentRenderedPreviewFrame[]> {
  const options = parsePreviewOptions(input);
  project = isolatePreviewLayers(project, options);
  const session = await openPreviewSession(
    { project, maxDimension: options.maxDimension ?? AGENT_PREVIEW_MAX_DIMENSION },
    signal,
  );
  const crop = previewCropPixels(session.width, session.height, options.crop);
  const frames: AgentRenderedPreviewFrame[] = [];
  let previousPixels: Uint8ClampedArray | undefined;
  let encodedBytes = 0;
  try {
    for (const time of times) {
      if (signal.aborted) throw new Error("Agent preview render was cancelled");
      const raw = await session.renderRawFrame(time);
      if (signal.aborted) throw new Error("Agent preview render was cancelled");
      const fullPixels = normalizeRgbaPixels(raw.pixels, raw.pixelFormat);
      const pixels = options.crop ? cropPixels(fullPixels, session.width, crop) : fullPixels;
      const measurements = measurePreviewPixels(pixels, previousPixels);
      const blob = await encodePng(crop.width, crop.height, pixels);
      encodedBytes += blob.size;
      if (encodedBytes > AGENT_PREVIEW_MAX_ENCODED_BYTES)
        throw new Error("Agent preview images exceeded the 8 MiB session budget");
      frames.push({
        time,
        renderId: `${crypto.randomUUID()}:${time.toFixed(6)}`,
        mimeType: "image/png",
        data: await blobToBase64(blob),
        width: crop.width,
        height: crop.height,
        measurements,
      });
      previousPixels = pixels;
    }
    return frames;
  } finally {
    session.close();
  }
}

async function openPreviewSession(options: FrameRenderSessionOptions, signal: AbortSignal) {
  const deadline = performance.now() + 10_000;
  while (true) {
    signal.throwIfAborted();
    try {
      return await openFrameRenderSession(options);
    } catch (error) {
      if (
        performance.now() >= deadline ||
        !(error instanceof Error) ||
        !/^Renderer did not (open|handle)/.test(error.message)
      )
        throw error;
      // The editor mounts before asynchronous GPU initialization completes.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

function cropPixels(
  pixels: Uint8ClampedArray,
  stride: number,
  crop: { x: number; y: number; width: number; height: number },
) {
  const result = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const start = ((y + crop.y) * stride + crop.x) * 4;
    result.set(pixels.subarray(start, start + crop.width * 4), y * crop.width * 4);
  }
  return result;
}

export function measurePreviewPixels(
  pixels: Uint8ClampedArray,
  previousPixels?: Uint8ClampedArray,
): AgentPreviewMeasurements {
  if (pixels.byteLength === 0 || pixels.byteLength % 4 !== 0)
    throw new Error("Agent preview pixels must be packed RGBA");
  if (previousPixels && previousPixels.byteLength !== pixels.byteLength)
    throw new Error("Agent preview comparison dimensions changed");
  const pixelCount = pixels.byteLength / 4;
  let visiblePixels = 0;
  let luminanceTotal = 0;
  let luminanceMinimum = 1;
  let luminanceMaximum = 0;
  let differenceTotal = 0;
  for (let index = 0; index < pixels.byteLength; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha > 1 / 255) visiblePixels += 1;
    const luminance =
      (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255;
    luminanceTotal += luminance;
    luminanceMinimum = Math.min(luminanceMinimum, luminance);
    luminanceMaximum = Math.max(luminanceMaximum, luminance);
    if (previousPixels)
      differenceTotal +=
        (Math.abs(pixels[index] - previousPixels[index]) +
          Math.abs(pixels[index + 1] - previousPixels[index + 1]) +
          Math.abs(pixels[index + 2] - previousPixels[index + 2]) +
          Math.abs(pixels[index + 3] - previousPixels[index + 3])) /
        (4 * 255);
  }
  const visiblePixelRatio = visiblePixels / pixelCount;
  return {
    averageLuminance: luminanceTotal / pixelCount,
    minimumLuminance: luminanceMinimum,
    maximumLuminance: luminanceMaximum,
    visiblePixelRatio,
    emptyFrame: visiblePixelRatio < 0.001 || luminanceMaximum < 1 / 255,
    ...(previousPixels ? { differenceFromPrevious: differenceTotal / pixelCount } : {}),
  };
}

function normalizeRgbaPixels(
  source: ArrayBuffer,
  pixelFormat: RawFramePixelFormat,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(source.slice(0));
  if (pixelFormat === "bgra")
    for (let index = 0; index < pixels.byteLength; index += 4) {
      const blue = pixels[index];
      pixels[index] = pixels[index + 2];
      pixels[index + 2] = blue;
    }
  return pixels;
}

async function encodePng(width: number, height: number, pixels: Uint8ClampedArray): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Agent preview encoder is unavailable");
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = await new Promise<Blob | undefined>((resolve) =>
    canvas.toBlob((value) => resolve(value ?? undefined), "image/png"),
  );
  if (!blob) throw new Error("Agent preview PNG encoding failed");
  return blob;
}
