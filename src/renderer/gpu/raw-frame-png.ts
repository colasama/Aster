import type { RawVideoFrame } from "./frame-readback";

export type RgbaPngEncoder = (
  width: number,
  height: number,
  pixels: Uint8ClampedArray<ArrayBuffer>,
) => Promise<Blob>;

export function normalizeRawFrameRgba(
  frame: RawVideoFrame,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("Raw frame dimensions must be positive integers");
  const expectedBytes = width * height * 4;
  if (frame.pixels.byteLength !== expectedBytes)
    throw new Error("Raw frame byte length does not match its dimensions");
  const source = new Uint8Array(frame.pixels);
  const rgba = new Uint8ClampedArray(expectedBytes);
  if (frame.pixelFormat === "rgba") {
    rgba.set(source);
    return rgba;
  }
  for (let index = 0; index < source.byteLength; index += 4) {
    rgba[index] = source[index + 2];
    rgba[index + 1] = source[index + 1];
    rgba[index + 2] = source[index];
    rgba[index + 3] = source[index + 3];
  }
  return rgba;
}

export async function encodeRawFramePng(
  frame: RawVideoFrame,
  width: number,
  height: number,
  encoder: RgbaPngEncoder = encodeBrowserPng,
): Promise<Blob> {
  return encoder(width, height, normalizeRawFrameRgba(frame, width, height));
}

async function encodeBrowserPng(
  width: number,
  height: number,
  pixels: Uint8ClampedArray<ArrayBuffer>,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG encoder canvas is unavailable");
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise<Blob | undefined>((resolve) =>
    canvas.toBlob((value) => resolve(value ?? undefined), "image/png"),
  );
  if (!blob) throw new Error("PNG encoder did not produce an image");
  return blob;
}
