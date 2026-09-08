import { CpuTaskError, type RadianceHdrCpuResult } from "../scheduling/cpu-task-protocol";
import { float32ToFloat16 } from "./half-float";

export const MAX_HDR_SOURCE_BYTES = 48 * 1024 * 1024;
export const MAX_HDR_WIDTH = 8_192;
export const MAX_HDR_HEIGHT = 4_096;
export const MAX_HDR_PIXELS = 16_777_216;

/**
 * Worker-side Radiance RGBE decoding. The optional payload is allocated directly in its final
 * 256-byte row-aligned binary16 layout, avoiding a second full decoded image.
 */
export function decodeRadianceHdrForUpload(
  source: Uint8Array,
  metadataOnly = false,
): RadianceHdrCpuResult {
  if (source.byteLength === 0 || source.byteLength > MAX_HDR_SOURCE_BYTES)
    fail("source-too-large", "HDR environment source exceeds the 48 MiB limit");
  const cursor = { offset: 0 };
  const signature = readAsciiLine(source, cursor);
  if (signature !== "#?RADIANCE" && signature !== "#?RGBE")
    fail("invalid-signature", "HDR environment has an invalid Radiance signature");
  let formatSeen = false;
  while (cursor.offset < source.length) {
    const line = readAsciiLine(source, cursor);
    if (line.length === 0) break;
    if (line === "FORMAT=32-bit_rle_rgbe") formatSeen = true;
  }
  if (!formatSeen) fail("invalid-format", "HDR environment must use 32-bit RLE RGBE");
  const resolution = readAsciiLine(source, cursor).trim();
  const match = /^-Y\s+(\d+)\s+\+X\s+(\d+)$/.exec(resolution);
  if (!match) fail("invalid-orientation", "HDR environment orientation must be -Y +X");
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_HDR_WIDTH ||
    height > MAX_HDR_HEIGHT ||
    width * height > MAX_HDR_PIXELS
  )
    fail("invalid-dimensions", "HDR environment dimensions exceed 8192×4096 or 16M pixels");

  const sourceBytesPerRow = width * 8;
  const bytesPerRow = Math.ceil(sourceBytesPerRow / 256) * 256;
  const rowElements = bytesPerRow / Uint16Array.BYTES_PER_ELEMENT;
  const pixels = metadataOnly ? undefined : new Uint16Array(rowElements * height);
  const scanline = new Uint8Array(width * 4);
  for (let y = 0; y < height; y += 1) {
    decodeScanline(source, cursor, width, scanline);
    if (!pixels) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * 4;
      const targetOffset = y * rowElements + x * 4;
      const exponent = scanline[sourceOffset + 3];
      const scale = exponent === 0 ? 0 : 2 ** (exponent - 136);
      pixels[targetOffset] = boundedHalf(scanline[sourceOffset] * scale);
      pixels[targetOffset + 1] = boundedHalf(scanline[sourceOffset + 1] * scale);
      pixels[targetOffset + 2] = boundedHalf(scanline[sourceOffset + 2] * scale);
      pixels[targetOffset + 3] = 0x3c00;
    }
  }
  if (cursor.offset !== source.length)
    fail("trailing-data", "HDR environment contains unexpected trailing bytes");
  return { width, height, bytesPerRow, pixels };
}

function decodeScanline(
  source: Uint8Array,
  cursor: { offset: number },
  width: number,
  output: Uint8Array,
): void {
  if (width >= 8 && width <= 0x7fff && isRleScanline(source, cursor.offset, width)) {
    cursor.offset += 4;
    const channels = new Uint8Array(width * 4);
    for (let channel = 0; channel < 4; channel += 1) {
      let written = 0;
      while (written < width) {
        const count = requireByte(source, cursor);
        if (count > 128) {
          const run = count - 128;
          if (run === 0 || written + run > width) fail("invalid-rle", "Invalid HDR RLE run");
          const value = requireByte(source, cursor);
          channels.fill(value, channel * width + written, channel * width + written + run);
          written += run;
        } else {
          if (count === 0 || written + count > width)
            fail("invalid-rle", "Invalid HDR RLE literal");
          for (let index = 0; index < count; index += 1)
            channels[channel * width + written++] = requireByte(source, cursor);
        }
      }
    }
    for (let x = 0; x < width; x += 1)
      for (let channel = 0; channel < 4; channel += 1)
        output[x * 4 + channel] = channels[channel * width + x];
    return;
  }
  const byteCount = width * 4;
  if (cursor.offset + byteCount > source.length) fail("truncated", "HDR scanline is truncated");
  output.set(source.subarray(cursor.offset, cursor.offset + byteCount));
  cursor.offset += byteCount;
}

function isRleScanline(source: Uint8Array, offset: number, width: number): boolean {
  return (
    offset + 4 <= source.length &&
    source[offset] === 2 &&
    source[offset + 1] === 2 &&
    (source[offset + 2] & 0x80) === 0 &&
    (source[offset + 2] << 8) + source[offset + 3] === width
  );
}

function requireByte(source: Uint8Array, cursor: { offset: number }): number {
  if (cursor.offset >= source.length) fail("truncated", "HDR environment is truncated");
  return source[cursor.offset++];
}

function readAsciiLine(source: Uint8Array, cursor: { offset: number }): string {
  const start = cursor.offset;
  while (cursor.offset < source.length && source[cursor.offset] !== 0x0a) {
    cursor.offset += 1;
    if (cursor.offset - start > 4_096)
      fail("invalid-header", "HDR environment header line is too long");
  }
  if (cursor.offset >= source.length) fail("truncated", "HDR environment header is truncated");
  const end =
    cursor.offset > start && source[cursor.offset - 1] === 0x0d ? cursor.offset - 1 : cursor.offset;
  cursor.offset += 1;
  return String.fromCharCode(...source.subarray(start, end));
}

function boundedHalf(value: number): number {
  return float32ToFloat16(value);
}

function fail(code: string, message: string): never {
  throw new CpuTaskError(code, message);
}
