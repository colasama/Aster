import UTIF, { type TiffIfd } from "utif";

export { isTiffSource } from "./tiff-source";

const MAX_TIFF_DIMENSION = 8_192;
const MAX_TIFF_PIXELS = 64 * 1024 * 1024;

export interface DecodedTiffImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Decodes the first TIFF image directory into straight-alpha sRGB RGBA pixels. */
export function decodeTiffRgba(bytes: ArrayBuffer): DecodedTiffImage {
  assertClassicTiff(bytes);
  let ifds: ReturnType<typeof UTIF.decode>;
  try {
    ifds = UTIF.decode(bytes);
  } catch (error) {
    throw tiffDecodeError(error);
  }
  const ifd = ifds[0];
  if (!ifd) throw new Error("TIFF contains no image directory");
  const taggedWidth = positiveInteger(ifd.t256?.[0]);
  const taggedHeight = positiveInteger(ifd.t257?.[0]);
  assertDecodedExtent(taggedWidth, taggedHeight);
  try {
    UTIF.decodeImage(bytes, ifd);
  } catch (error) {
    throw tiffDecodeError(error);
  }
  const width = positiveInteger(ifd.width) || taggedWidth;
  const height = positiveInteger(ifd.height) || taggedHeight;
  assertDecodedExtent(width, height);
  let pixels: Uint8Array;
  try {
    pixels = tiffPixelsToRgba(ifd, width, height);
  } catch (error) {
    throw tiffDecodeError(error);
  }
  const expectedBytes = width * height * 4;
  if (pixels.byteLength !== expectedBytes)
    throw new Error(
      `TIFF decoded pixel plane is invalid: expected ${expectedBytes} bytes, received ${pixels.byteLength}`,
    );
  return { width, height, pixels };
}

function tiffPixelsToRgba(ifd: TiffIfd, width: number, height: number): Uint8Array {
  const interpretation = tagValues(ifd, "t262")[0] ?? 2;
  if (interpretation === 6) return yCbCrPixelsToRgba(ifd, width, height);
  if (![0, 1, 2, 3, 5].includes(interpretation))
    throw new Error(`TIFF photometric interpretation ${interpretation} is not supported`);
  return UTIF.toRGBA8(ifd);
}

/** Handles TIFF's packed Y samples plus shared chroma samples, which UTIF does not expand. */
function yCbCrPixelsToRgba(ifd: TiffIfd, width: number, height: number): Uint8Array {
  const bits = tagValues(ifd, "t258");
  const samples = tagValues(ifd, "t277")[0] ?? bits.length;
  const planarConfiguration = tagValues(ifd, "t284")[0] ?? 1;
  if (samples !== 3 || bits.length !== 3 || bits.some((value) => value !== 8))
    throw new Error("TIFF YCbCr fallback requires three 8-bit samples");
  if (planarConfiguration !== 1)
    throw new Error("TIFF YCbCr fallback requires contiguous sample planes");
  if (tagValues(ifd, "t324").length > 0)
    throw new Error("Tiled TIFF YCbCr images are not supported");
  const data = ifd.data;
  if (!(data instanceof Uint8Array)) throw new Error("TIFF decoder returned no sample plane");
  const subsampling = tagValues(ifd, "t530");
  const horizontal = positiveInteger(subsampling[0]) || 2;
  const vertical = positiveInteger(subsampling[1]) || 2;
  if (horizontal > 4 || vertical > 4)
    throw new Error("TIFF YCbCr subsampling exceeds the supported 4×4 block size");
  const coefficients = tagValues(ifd, "t529");
  const redWeight = coefficients[0] ?? 0.299;
  const greenWeight = coefficients[1] ?? 0.587;
  const blueWeight = coefficients[2] ?? 0.114;
  if (
    redWeight <= 0 ||
    greenWeight <= 0 ||
    blueWeight <= 0 ||
    Math.abs(redWeight + greenWeight + blueWeight - 1) > 0.01
  )
    throw new Error("TIFF YCbCr coefficients are invalid");
  const reference = tagValues(ifd, "t532");
  const [yBlack, yWhite, cbBlack, cbWhite, crBlack, crWhite] =
    reference.length >= 6 ? reference : [0, 255, 128, 255, 128, 255];
  if (yWhite <= yBlack || cbWhite <= cbBlack || crWhite <= crBlack)
    throw new Error("TIFF YCbCr reference black/white values are invalid");
  const rowsPerStrip = Math.min(positiveInteger(tagValues(ifd, "t278")[0]) || height, height);
  const stripCount = Math.ceil(height / rowsPerStrip);
  const decodedRowBytes = width * samples;
  const blockColumns = Math.ceil(width / horizontal);
  const blockSamples = horizontal * vertical;
  const output = new Uint8Array(width * height * 4);
  for (let strip = 0; strip < stripCount; strip += 1) {
    const firstRow = strip * rowsPerStrip;
    const stripRows = Math.min(rowsPerStrip, height - firstRow);
    const blockRows = Math.ceil(stripRows / vertical);
    const packedBytes = blockColumns * blockRows * (blockSamples + 2);
    let sourceOffset = strip * decodedRowBytes * rowsPerStrip;
    if (sourceOffset + packedBytes > data.byteLength)
      throw new Error(`TIFF YCbCr strip ${strip + 1} is truncated`);
    for (let blockY = 0; blockY < blockRows; blockY += 1) {
      for (let blockX = 0; blockX < blockColumns; blockX += 1) {
        const yOffset = sourceOffset;
        sourceOffset += blockSamples;
        const cb = ((data[sourceOffset] ?? 0) - cbBlack) * (127 / (cbWhite - cbBlack));
        const cr = ((data[sourceOffset + 1] ?? 0) - crBlack) * (127 / (crWhite - crBlack));
        sourceOffset += 2;
        for (let localY = 0; localY < vertical; localY += 1) {
          const row = firstRow + blockY * vertical + localY;
          if (row >= firstRow + stripRows || row >= height) continue;
          for (let localX = 0; localX < horizontal; localX += 1) {
            const column = blockX * horizontal + localX;
            if (column >= width) continue;
            const yCode = data[yOffset + localY * horizontal + localX] ?? 0;
            const luminance = (yCode - yBlack) * (255 / (yWhite - yBlack));
            const red = luminance + cr * (2 - 2 * redWeight);
            const blue = luminance + cb * (2 - 2 * blueWeight);
            const green = (luminance - redWeight * red - blueWeight * blue) / greenWeight;
            const destination = (row * width + column) * 4;
            output[destination] = clampedByte(red);
            output[destination + 1] = clampedByte(green);
            output[destination + 2] = clampedByte(blue);
            output[destination + 3] = 255;
          }
        }
      }
    }
  }
  return output;
}

function tagValues(ifd: TiffIfd, tag: string): number[] {
  const value = ifd[tag];
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : [];
}

function clampedByte(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)));
}

function assertClassicTiff(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 8) throw new Error("TIFF payload is truncated");
  const header = new Uint8Array(bytes, 0, 4);
  const littleEndian = header[0] === 0x49 && header[1] === 0x49;
  const bigEndian = header[0] === 0x4d && header[1] === 0x4d;
  if (!littleEndian && !bigEndian) throw new Error("TIFF byte-order marker is invalid");
  const magic = littleEndian ? header[2] | (header[3] << 8) : (header[2] << 8) | header[3];
  if (magic === 43) throw new Error("BigTIFF is not supported; convert the source to classic TIFF");
  if (magic !== 42) throw new Error("TIFF header signature is invalid");
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function assertDecodedExtent(width: number, height: number): void {
  if (width < 1 || height < 1) throw new Error("TIFF image dimensions are invalid");
  if (width > MAX_TIFF_DIMENSION || height > MAX_TIFF_DIMENSION)
    throw new Error(`TIFF dimensions exceed ${MAX_TIFF_DIMENSION} pixels per axis`);
  if (width * height > MAX_TIFF_PIXELS)
    throw new Error("TIFF decoded image exceeds the 256 MiB RGBA limit");
}

function tiffDecodeError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`TIFF pixel decode failed: ${detail}`);
}
