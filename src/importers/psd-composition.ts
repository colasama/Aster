import type { ParsedPsdDocument, ParsedPsdLayer, PsdRectangle } from "./psd";

export type PsdImportMode = "merged" | "composition" | "compositionRetainLayerSizes";
export type PsdImportBlendMode = "normal" | "add" | "multiply" | "screen" | "overlay";

export interface PsdImportWarning {
  code: "emptyLayer" | "unsupportedBlendMode";
  layerName: string;
  message: string;
}

export interface PsdLayerImportPlan {
  key: string;
  name: string;
  sectionType?: ParsedPsdLayer["sectionType"];
  sourceSize: [number, number];
  /** Location of decoded pixels within the logical source surface. */
  pixelOrigin: [number, number];
  /** Crop within the decoded layer pixels after clipping to the document. */
  pixelCrop: [number, number, number, number];
  sourceRectangle: PsdRectangle;
  position: [number, number];
  anchor: [number, number];
  opacity: number;
  visible: boolean;
  blendMode: PsdImportBlendMode;
  originalBlendMode: string;
  pixels: Uint8ClampedArray;
}

export interface PsdCompositionImportPlan {
  mode: PsdImportMode;
  name: string;
  width: number;
  height: number;
  layers: readonly PsdLayerImportPlan[];
  warnings: readonly PsdImportWarning[];
}

/**
 * Plans Adobe's merged/composition/retain-layer-sizes PSD import modes without padding or copying
 * decoded pixel planes. The renderer can place each cropped upload at pixelOrigin on its logical
 * source surface.
 */
export function planPsdImport(
  document: ParsedPsdDocument,
  mode: PsdImportMode,
  name = "Imported PSD",
): PsdCompositionImportPlan {
  if (mode === "merged") return mergedPlan(document, name);
  const warnings: PsdImportWarning[] = [];
  const keys = new Set<string>();
  const layers = document.layers.map((layer, index) => {
    const blendMode = mapPsdBlendMode(layer.blendMode);
    if (!isExactBlendMode(layer.blendMode))
      warnings.push({
        code: "unsupportedBlendMode",
        layerName: layer.name,
        message: `PSD blend mode ${layer.blendMode} is imported as ${blendMode}`,
      });
    if (layer.width === 0 || layer.height === 0)
      warnings.push({
        code: "emptyLayer",
        layerName: layer.name,
        message: "PSD layer has no pixel bounds",
      });
    const pixelCrop = clippedPixelCrop(layer, document.width, document.height);
    const retained = mode === "compositionRetainLayerSizes";
    const sourceSize: [number, number] = retained
      ? [layer.width, layer.height]
      : [document.width, document.height];
    const baseKey = layer.id === undefined ? `index-${index}` : `layer-${layer.id}`;
    const key = uniqueKey(baseKey, keys);
    return {
      key,
      name: layer.name,
      ...(layer.sectionType ? { sectionType: layer.sectionType } : {}),
      sourceSize,
      pixelOrigin: retained ? [0, 0] : [layer.rectangle.left, layer.rectangle.top],
      pixelCrop,
      sourceRectangle: layer.rectangle,
      position: retained
        ? [layer.rectangle.left + layer.width * 0.5, layer.rectangle.top + layer.height * 0.5]
        : [document.width * 0.5, document.height * 0.5],
      anchor: retained
        ? [layer.width * 0.5, layer.height * 0.5]
        : [document.width * 0.5, document.height * 0.5],
      opacity: clamp(layer.opacity, 0, 1),
      visible: layer.visible,
      blendMode,
      originalBlendMode: layer.blendMode,
      pixels: layer.pixels,
    } satisfies PsdLayerImportPlan;
  });
  return {
    mode,
    name,
    width: document.width,
    height: document.height,
    layers,
    warnings,
  };
}

export function mapPsdBlendMode(value: string): PsdImportBlendMode {
  switch (value) {
    case "mul ":
      return "multiply";
    case "scrn":
      return "screen";
    case "over":
      return "overlay";
    case "lddg":
    case "add ":
      return "add";
    default:
      return "normal";
  }
}

function mergedPlan(document: ParsedPsdDocument, name: string): PsdCompositionImportPlan {
  if (!document.composite) throw new Error("PSD merged composite is unavailable");
  return {
    mode: "merged",
    name,
    width: document.width,
    height: document.height,
    layers: [
      {
        key: "merged",
        name,
        sourceSize: [document.width, document.height],
        pixelOrigin: [0, 0],
        pixelCrop: [0, 0, document.width, document.height],
        sourceRectangle: { top: 0, left: 0, bottom: document.height, right: document.width },
        position: [document.width * 0.5, document.height * 0.5],
        anchor: [document.width * 0.5, document.height * 0.5],
        opacity: 1,
        visible: true,
        blendMode: "normal",
        originalBlendMode: "norm",
        pixels: document.composite,
      },
    ],
    warnings: [],
  };
}

function clippedPixelCrop(
  layer: Pick<ParsedPsdLayer, "rectangle" | "width" | "height">,
  documentWidth: number,
  documentHeight: number,
): [number, number, number, number] {
  const left = clamp(layer.rectangle.left, 0, documentWidth);
  const top = clamp(layer.rectangle.top, 0, documentHeight);
  const right = clamp(layer.rectangle.right, 0, documentWidth);
  const bottom = clamp(layer.rectangle.bottom, 0, documentHeight);
  return [
    clamp(left - layer.rectangle.left, 0, layer.width),
    clamp(top - layer.rectangle.top, 0, layer.height),
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  ];
}

function uniqueKey(base: string, keys: Set<string>): string {
  let key = base;
  let suffix = 2;
  while (keys.has(key)) key = `${base}-${suffix++}`;
  keys.add(key);
  return key;
}

function isExactBlendMode(value: string): boolean {
  return (
    value === "norm" ||
    value === "mul " ||
    value === "scrn" ||
    value === "over" ||
    value === "lddg" ||
    value === "add "
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, finite));
}
