import { evaluateLayerTransform } from "../../core/animation/expressions";
import type { FootageSource, Layer } from "../../core/types";
import type { RuntimePsdLayer } from "../../importers/media-import-runtime";
import { svgTransformedRasterSize } from "../../importers/svg-raster-cache";
import type { PreparedImagePixels } from "./image-raster-upload";
import { preparedRasterIdentity } from "./media-frame-identity";
import { svgPreviewRasterTarget } from "./media-loading";

/** Freezes the decoded plane's crop and byte layout before a GPU consumer sees it. */
export function preparePsdRaster(
  runtime: RuntimePsdLayer,
  footage: FootageSource,
  locator: string,
  maximumDimension: number,
  maximumBytes: number,
) {
  const [cropX, cropY, width, height] = runtime.crop;
  if (
    ![cropX, cropY, width, height, runtime.decodedWidth, runtime.decodedHeight].every(
      Number.isSafeInteger,
    ) ||
    width < 1 ||
    height < 1 ||
    width > maximumDimension ||
    height > maximumDimension ||
    width * height * 4 > maximumBytes ||
    cropX < 0 ||
    cropY < 0 ||
    cropX + width > runtime.decodedWidth ||
    cropY + height > runtime.decodedHeight
  )
    throw new Error("PSD layer crop exceeds the available GPU texture or decoded pixel bounds");
  if (runtime.pixels.byteLength < runtime.decodedWidth * runtime.decodedHeight * 4)
    throw new Error("PSD decoded pixel plane is truncated");
  const generation = JSON.stringify([
    footage.contentIdentity,
    runtime.documentIdentity,
    runtime.layerKey,
    runtime.decodedWidth,
    runtime.decodedHeight,
    cropX,
    cropY,
    width,
    height,
  ]);
  const pixels: PreparedImagePixels = {
    kind: "rgba",
    bytes: runtime.pixels,
    width,
    height,
    layout: {
      offset: (cropY * runtime.decodedWidth + cropX) * 4,
      bytesPerRow: runtime.decodedWidth * 4,
      rowsPerImage: runtime.decodedHeight,
    },
  };
  return {
    source: JSON.stringify([locator, generation]),
    pixels,
    identity: preparedRasterIdentity(footage.id, "psd", generation, {
      x: cropX,
      y: cropY,
      width,
      height,
    }),
  };
}

/** Evaluation chooses an exact raster request; upload only consumes its completed bitmap. */
export function prepareSvgRaster(
  layer: Layer,
  footage: FootageSource,
  time: number,
  locator: string,
  resolutionScale: number,
  maximumDimension: number,
) {
  const transform = evaluateLayerTransform(layer, time);
  const size = svgTransformedRasterSize(layer.size, transform.scale);
  const target = svgPreviewRasterTarget(
    size.displayWidth,
    size.displayHeight,
    resolutionScale,
    maximumDimension,
  );
  const generation = JSON.stringify([footage.contentIdentity, target.width, target.height]);
  return {
    source: JSON.stringify([locator, generation]),
    target,
    identity: preparedRasterIdentity(footage.id, "svg", generation, {
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
    }),
  };
}
