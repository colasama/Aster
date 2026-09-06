import { Type } from "typebox";
import { Check } from "typebox/value";

export const previewFields = {
  maxDimension: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048 })),
  crop: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
        height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  layerIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 }),
  ),
};

export interface PreviewOptions {
  maxDimension?: number;
  crop?: { x: number; y: number; width: number; height: number };
  layerIds?: string[];
}

export function parsePreviewOptions(input: PreviewOptions): PreviewOptions {
  const options = { maxDimension: input.maxDimension, crop: input.crop, layerIds: input.layerIds };
  if (!Check(Type.Object(previewFields), options)) throw new Error("Invalid preview options");
  if (
    options.crop &&
    (options.crop.x + options.crop.width > 1 || options.crop.y + options.crop.height > 1)
  )
    throw new Error("Preview crop must stay inside the frame");
  return options;
}

export function previewCropPixels(width: number, height: number, crop?: PreviewOptions["crop"]) {
  if (!crop) return { x: 0, y: 0, width, height };
  parsePreviewOptions({ crop });
  const x = Math.min(width - 1, Math.floor(crop.x * width));
  const y = Math.min(height - 1, Math.floor(crop.y * height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(crop.width * width))),
    height: Math.max(1, Math.min(height - y, Math.round(crop.height * height))),
  };
}
