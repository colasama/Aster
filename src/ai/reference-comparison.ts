import { type PreviewOptions, previewCropPixels } from "./preview-options";
import type { AgentRenderedPreviewFrame } from "./render-preview";

export interface ReferenceFrame {
  time: number;
  actualTime: number;
  width: number;
  height: number;
  mimeType: "image/png";
  data: string;
}

export function pixelDifference(reference: Uint8ClampedArray, rendered: Uint8ClampedArray) {
  if (!reference.length || reference.length !== rendered.length || reference.length % 4)
    throw new Error("Comparison requires equal nonempty RGBA images");
  const pixels = new Uint8ClampedArray(reference.length);
  let total = 0;
  for (let i = 0; i < reference.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      // Compare the visible image over black, rather than invisible RGB in transparent pixels.
      const difference = Math.abs(
        (reference[i + channel] * reference[i + 3]) / 255 -
          (rendered[i + channel] * rendered[i + 3]) / 255,
      );
      pixels[i + channel] = difference;
      total += difference;
    }
    pixels[i + 3] = 255;
  }
  return { pixels, meanAbsoluteRgbError: total / ((reference.length / 4) * 3 * 255) };
}

export async function compareReferenceFrames(
  rendered: AgentRenderedPreviewFrame[],
  references: ReferenceFrame[],
  options: PreviewOptions,
  signal: AbortSignal,
) {
  if (rendered.length !== references.length)
    throw new Error("Comparison sample counts do not match");
  const frames = [];
  let bytes = 0;
  for (const [index, render] of rendered.entries()) {
    signal.throwIfAborted();
    const reference = references[index];
    const [referenceImage, renderImage] = await Promise.all([decode(reference), decode(render)]);
    try {
      const crop = previewCropPixels(reference.width, reference.height, options.crop);
      if (
        Math.abs(crop.width / crop.height - render.width / render.height) >
        2 / Math.min(crop.height, render.height)
      )
        throw new Error(
          "Reference and composition aspect ratios differ; match composition dimensions before comparing",
        );
      const [left, leftContext] = canvas(render.width, render.height);
      leftContext.drawImage(
        referenceImage,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        render.width,
        render.height,
      );
      const [right, rightContext] = canvas(render.width, render.height);
      rightContext.drawImage(renderImage, 0, 0);
      const difference = pixelDifference(
        leftContext.getImageData(0, 0, render.width, render.height).data,
        rightContext.getImageData(0, 0, render.width, render.height).data,
      );
      const [diff, diffContext] = canvas(render.width, render.height);
      diffContext.putImageData(
        new ImageData(new Uint8ClampedArray(difference.pixels), render.width, render.height),
        0,
        0,
      );
      const [sideBySide, sideContext] = canvas(render.width * 2, render.height);
      sideContext.drawImage(left, 0, 0);
      sideContext.drawImage(right, render.width, 0);
      const [overlay, overlayContext] = canvas(render.width, render.height);
      overlayContext.drawImage(left, 0, 0);
      overlayContext.globalAlpha = 0.5;
      overlayContext.drawImage(right, 0, 0);
      const images = [sideBySide, overlay, diff].map((image, i) => ({
        role: ["reference-left-render-right", "overlay", "absolute-difference"][i],
        width: image.width,
        height: image.height,
        mimeType: "image/png",
        data: image.toDataURL("image/png").split(",")[1],
      }));
      bytes += images.reduce((sum, image) => sum + image.data.length, 0);
      if (bytes > 24 * 1024 * 1024)
        throw new Error("Comparison image budget exceeded; request fewer frames or a smaller size");
      frames.push({
        requestedReferenceTime: reference.time,
        actualReferenceTime: reference.actualTime,
        renderTime: render.time,
        meanAbsoluteRgbError: difference.meanAbsoluteRgbError,
        images,
      });
    } finally {
      referenceImage.close();
      renderImage.close();
    }
  }
  return {
    verification: "metrics_only",
    limitation:
      "Display RGB pixel error is not a perceptual similarity score. HDR references require explicit matching color interpretation.",
    frames,
  };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  const context = result.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Comparison canvas is unavailable");
  return [result, context];
}

async function decode(frame: { data: string; mimeType: string }) {
  const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: frame.mimeType }));
}
