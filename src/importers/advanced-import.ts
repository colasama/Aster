import { createLayerForComposition } from "../core/layer-factory";
import type { Composition, FootageSource, Layer } from "../core/types";
import { createId, staticValue } from "../core/types";
import { detectImageSequence, type ImageSequenceSelection } from "./image-sequence";
import type { MissingSequenceFramePolicy } from "./image-sequence-runtime";
import { mediaBytesIdentity, mediaTextIdentity } from "./media-import-identity";
import {
  mediaImportRuntime,
  type RuntimeSequenceFile,
  runtimeSourceLocator,
} from "./media-import-runtime";
import { type ParsedPsdDocument, parsePsd } from "./psd";
import {
  type PsdCompositionImportPlan,
  type PsdImportMode,
  planPsdImport,
} from "./psd-composition";
import { type ParsedSvgSource, parseSvgSource } from "./svg";

export interface AdvancedImportResult {
  sources: FootageSource[];
  layers: Layer[];
  composition?: Composition;
  warnings: string[];
}

export interface SequenceImportOptions {
  frameRate: { numerator: number; denominator: number };
  missingFramePolicy: MissingSequenceFramePolicy;
  loop?: boolean;
}

export interface BrowserSequenceInput {
  selection: ImageSequenceSelection<RuntimeSequenceFile>;
  dispose?: () => void;
}

export function detectAdvancedImportKind(
  file: Pick<File, "name" | "type">,
): "psd" | "svg" | "image" | undefined {
  const extension = file.name.toLocaleLowerCase();
  if (file.type === "image/vnd.adobe.photoshop" || extension.endsWith(".psd")) return "psd";
  if (file.type === "image/svg+xml" || extension.endsWith(".svg")) return "svg";
  if (file.type.startsWith("image/")) return "image";
  return undefined;
}

export async function importSvgFile(
  file: Pick<File, "name" | "text"> & { runtimeUrl?: string },
  composition: Composition,
  currentTime: number,
): Promise<AdvancedImportResult> {
  return createSvgImport(
    parseSvgSource(await file.text()),
    file.name,
    composition,
    currentTime,
    file.runtimeUrl,
  );
}

export function createSvgImport(
  parsed: ParsedSvgSource,
  fileName: string,
  composition: Composition,
  currentTime: number,
  runtimeUrl?: string,
): AdvancedImportResult {
  const sourceId = createId();
  const source: FootageSource = {
    id: sourceId,
    kind: "svg",
    name: fileName,
    mimeType: "image/svg+xml",
    contentIdentity: mediaTextIdentity(parsed.sanitized),
    runtimeUrl: runtimeUrl ?? runtimeSourceLocator(sourceId),
    interpretation: { alpha: "straight", colorSpace: "srgb" },
    width: parsed.width,
    height: parsed.height,
  };
  mediaImportRuntime.register(sourceId, { kind: "svg", parsed });
  const layer = imageLayer(source, composition, currentTime, parsed.width, parsed.height);
  return { sources: [source], layers: [layer], warnings: [] };
}

export async function importPsdFile(
  file: Pick<File, "name" | "arrayBuffer"> & { runtimeUrl?: string; sourcePath?: string },
  mode: PsdImportMode,
  composition: Composition,
  currentTime: number,
): Promise<AdvancedImportResult> {
  const buffer = await file.arrayBuffer();
  const identity = mediaBytesIdentity(new Uint8Array(buffer));
  return createPsdImport(
    await parsePsd(buffer),
    mode,
    file.name,
    identity,
    composition,
    currentTime,
    new Uint8Array(buffer.slice(0)),
    file.runtimeUrl,
    file.sourcePath,
  );
}

export function createPsdImport(
  document: ParsedPsdDocument,
  mode: PsdImportMode,
  fileName: string,
  documentIdentity: string,
  activeComposition: Composition,
  currentTime: number,
  documentBytes?: Uint8Array,
  runtimeUrl?: string,
  originalPath?: string,
): AdvancedImportResult {
  const name = withoutExtension(fileName);
  const plan = planPsdImport(document, mode, name);
  const target =
    mode === "merged" ? activeComposition : psdComposition(plan, activeComposition, name);
  const sources: FootageSource[] = [];
  const layers: Layer[] = [];
  const warnings = plan.warnings.map((warning) => warning.message);
  for (const planned of plan.layers) {
    if (planned.sectionType) continue;
    const [cropX, cropY, cropWidth, cropHeight] = planned.pixelCrop;
    if (cropWidth < 1 || cropHeight < 1 || planned.pixels.byteLength < 4) {
      warnings.push(`PSD layer ${planned.name} has no drawable pixels and was skipped`);
      continue;
    }
    const sourceId = createId();
    const source: FootageSource = {
      id: sourceId,
      kind: "psd",
      name: planned.name,
      mimeType: "image/vnd.adobe.photoshop",
      contentIdentity: `${documentIdentity}:${mode}:${planned.key}`,
      runtimeUrl: runtimeUrl ?? runtimeSourceLocator(sourceId),
      interpretation: { alpha: "straight", colorSpace: "srgb" },
      width: planned.sourceSize[0],
      height: planned.sourceSize[1],
      layerCount: document.layers.length,
    };
    mediaImportRuntime.register(sourceId, {
      kind: "psd",
      documentIdentity,
      importMode: mode,
      layerKey: planned.key,
      ...(documentBytes ? { documentBytes } : {}),
      ...(originalPath ? { originalPath } : {}),
      decodedWidth: Math.max(1, planned.sourceRectangle.right - planned.sourceRectangle.left),
      decodedHeight: Math.max(1, planned.sourceRectangle.bottom - planned.sourceRectangle.top),
      crop: [cropX, cropY, cropWidth, cropHeight],
      pixels: planned.pixels,
    });
    const position: [number, number] =
      mode === "merged"
        ? [activeComposition.width * 0.5, activeComposition.height * 0.5]
        : [
            planned.sourceRectangle.left + cropX + cropWidth * 0.5,
            planned.sourceRectangle.top + cropY + cropHeight * 0.5,
          ];
    const layer = imageLayer(
      source,
      target,
      mode === "merged" ? currentTime : 0,
      cropWidth,
      cropHeight,
    );
    layer.name = planned.name;
    layer.visible = planned.visible;
    layer.blendMode = planned.blendMode;
    layer.transform.position[0] = staticValue(position[0]);
    layer.transform.position[1] = staticValue(position[1]);
    layer.transform.anchor[0] = staticValue(planned.anchor[0]);
    layer.transform.anchor[1] = staticValue(planned.anchor[1]);
    layer.transform.opacity = staticValue(planned.opacity * 100);
    sources.push(source);
    layers.push(layer);
  }
  if (layers.length === 0) throw new Error("PSD contains no drawable pixel layers");
  if (target !== activeComposition) target.layers = layers;
  return {
    sources,
    layers,
    ...(target !== activeComposition ? { composition: target } : {}),
    warnings,
  };
}

export async function createBrowserSequenceInput(
  files: readonly File[],
  selectedName?: string,
): Promise<BrowserSequenceInput> {
  const urls: string[] = [];
  try {
    const detected = detectImageSequence(files, selectedName);
    const runtimeFrames = detected.frames.map(({ frame, file }) => {
      const url = URL.createObjectURL(file);
      urls.push(url);
      return {
        frame,
        file: {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          url,
        } satisfies RuntimeSequenceFile,
      };
    });
    return {
      selection: { ...detected, frames: runtimeFrames },
      dispose: () => {
        for (const url of urls) URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  }
}

export async function imageDimensionsFromUrl(url: string): Promise<[number, number]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (bitmap.width < 1 || bitmap.height < 1)
      throw new Error("Image frame has invalid dimensions");
    return [bitmap.width, bitmap.height];
  } finally {
    bitmap.close();
  }
}

export function createImageSequenceImport(
  input: BrowserSequenceInput,
  dimensions: readonly [number, number],
  options: SequenceImportOptions,
  composition: Composition,
  currentTime: number,
): AdvancedImportResult {
  validateFrameRate(options.frameRate);
  const sourceId = createId();
  const selection = input.selection;
  const contentIdentity = sequenceIdentity(selection);
  const source: FootageSource = {
    id: sourceId,
    kind: "imageSequence",
    name: selection.pattern,
    mimeType: selection.frames[0]?.file.type || "image/*",
    contentIdentity,
    runtimeUrl: runtimeSourceLocator(sourceId),
    interpretation: {
      alpha: "straight",
      colorSpace: "srgb",
      frameRate: { ...options.frameRate },
    },
    width: dimensions[0],
    height: dimensions[1],
    pattern: selection.pattern,
    startFrame: selection.startFrame,
    endFrame: selection.endFrame,
  };
  mediaImportRuntime.register(
    sourceId,
    {
      kind: "imageSequence",
      selection,
      frameRate: { ...options.frameRate },
      missingFramePolicy: options.missingFramePolicy,
      loop: options.loop ?? false,
    },
    input.dispose,
  );
  const layer = imageLayer(source, composition, currentTime, dimensions[0], dimensions[1]);
  const frameCount = selection.endFrame - selection.startFrame + 1;
  const duration = (frameCount * options.frameRate.denominator) / options.frameRate.numerator;
  layer.outPoint = Math.min(composition.duration, currentTime + duration);
  return {
    sources: [source],
    layers: [layer],
    warnings:
      selection.missingFrames.length > 0
        ? [`${selection.missingFrames.length} image sequence frame(s) are missing`]
        : [],
  };
}

function imageLayer(
  source: FootageSource,
  composition: Composition,
  currentTime: number,
  width: number,
  height: number,
): Layer {
  const layer = createLayerForComposition("image", composition, currentTime);
  layer.name = source.name;
  layer.sourceId = source.id;
  layer.size = [width, height];
  return layer;
}

function psdComposition(
  plan: PsdCompositionImportPlan,
  activeComposition: Composition,
  name: string,
): Composition {
  return {
    id: createId(),
    name,
    width: plan.width,
    height: plan.height,
    frameRate: { ...activeComposition.frameRate },
    duration: activeComposition.duration,
    workArea: { ...activeComposition.workArea },
    background: [0, 0, 0, 0],
    motionBlur: { ...activeComposition.motionBlur },
    layers: [],
  };
}

function validateFrameRate(frameRate: { numerator: number; denominator: number }): void {
  if (
    !Number.isSafeInteger(frameRate.numerator) ||
    frameRate.numerator < 1 ||
    frameRate.numerator > 1_000_000 ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.denominator < 1 ||
    frameRate.denominator > 1_000_000
  )
    throw new Error("Image sequence frame rate must be a positive exact rational");
}

function sequenceIdentity(selection: ImageSequenceSelection<RuntimeSequenceFile>): string {
  return mediaTextIdentity(
    selection.frames
      .map(
        ({ frame, file }) => `${frame}:${file.name}:${file.size}:${file.lastModified}:${file.type}`,
      )
      .join("|"),
  );
}

function withoutExtension(value: string): string {
  return value.replace(/\.[^.]+$/, "") || "Imported PSD";
}
