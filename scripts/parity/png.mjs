import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DIMENSION = 32_768;
const MAX_PIXEL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_PIXEL_BYTES + 1024 * 1024;
const MAX_CHUNKS = 65_536;

/** Writes raw RGBA8 bytes unchanged, including RGB beneath zero alpha. */
export function encodeRgbaPng(width, height, pixels) {
  const layout = imageLayout(width, height, 4);
  const rgba = byteView(pixels);
  if (rgba.length !== layout.pixelBytes)
    throw new Error("PNG RGBA input length does not match its dimensions");
  const rows = Buffer.allocUnsafe(layout.filteredBytes);
  for (let y = 0; y < height; y += 1) {
    rows[y * layout.stride] = 0;
    rgba.copy(rows, y * layout.stride + 1, y * layout.rowBytes, (y + 1) * layout.rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const encoded = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (encoded.length > MAX_FILE_BYTES) throw new Error("PNG exceeds the encoded byte budget");
  return encoded;
}

/** Reads non-interlaced RGB8/RGBA8 only; metadata never changes the stored channel values. */
export function decodeRgbaPng(input) {
  const bytes = byteView(input);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("PNG exceeds the encoded byte budget");
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE))
    throw new Error("Invalid PNG signature");
  let layout;
  let palette = false;
  let imageStarted = false;
  let imageEnded = false;
  let finished = false;
  let count = 0;
  const compressed = [];
  for (let offset = 8; offset < bytes.length; ) {
    if (++count > MAX_CHUNKS) throw new Error("PNG exceeds the chunk count budget");
    if (bytes.length - offset < 12) throw new Error("Truncated PNG chunk header");
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) throw new Error("Invalid PNG chunk length");
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error("Truncated PNG chunk payload");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw new Error("Invalid PNG chunk type");
    // ASCII decoding masks high bits, so validate the original bytes as well.
    if (bytes.subarray(offset + 4, offset + 8).some((value) => value > 127))
      throw new Error("Invalid PNG chunk type");
    if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end))
      throw new Error(`PNG ${type} CRC mismatch`);
    const data = bytes.subarray(offset + 8, end);
    if (!layout && type !== "IHDR") throw new Error("PNG IHDR must be the first chunk");
    if (type === "IHDR") {
      if (layout) throw new Error("Duplicate PNG IHDR chunk");
      layout = decodeHeader(data);
    } else if (type === "IDAT") {
      if (imageEnded) throw new Error("PNG IDAT chunks must be consecutive");
      imageStarted = true;
      compressed.push(data);
    } else {
      if (imageStarted) imageEnded = true;
      if (type === "IEND") {
        if (length !== 0) throw new Error("PNG IEND must be empty");
        if (!imageStarted) throw new Error("PNG has no IDAT image data");
        if (end + 4 !== bytes.length) throw new Error("PNG has trailing data after IEND");
        finished = true;
      } else if (type === "PLTE") {
        if (palette || imageStarted || length === 0 || length > 768 || length % 3 !== 0)
          throw new Error("Invalid PNG PLTE chunk");
        palette = true;
      } else if (type === "tRNS") {
        throw new Error("PNG tRNS transparency is unsupported; use RGBA8");
      } else if (["acTL", "fcTL", "fdAT"].includes(type)) {
        throw new Error("Animated PNG is unsupported");
      } else if (type[0] === type[0].toUpperCase()) {
        throw new Error(`Unsupported PNG critical chunk ${type}`);
      }
    }
    offset = end + 4;
  }
  if (!layout || !finished) throw new Error("PNG is missing IHDR or IEND");
  const encoded = Buffer.concat(compressed);
  let inflated;
  try {
    inflated = inflateSync(encoded, { maxOutputLength: layout.filteredBytes, info: true });
  } catch (cause) {
    throw new Error("PNG image data is invalid or exceeds its decompression budget", { cause });
  }
  if (inflated.engine.bytesWritten !== encoded.length)
    throw new Error("PNG IDAT contains trailing compressed data");
  const rows = inflated.buffer;
  if (rows.length !== layout.filteredBytes)
    throw new Error("PNG decompressed length does not match its dimensions");
  unfilter(rows, layout);
  const pixels = Buffer.allocUnsafe(layout.width * layout.height * 4);
  for (let y = 0; y < layout.height; y += 1) {
    const row = rows.subarray(y * layout.stride + 1, (y + 1) * layout.stride);
    if (layout.channels === 4) row.copy(pixels, y * layout.rowBytes);
    else {
      for (let x = 0; x < layout.width; x += 1) {
        const offset = (y * layout.width + x) * 4;
        pixels[offset] = row[x * 3];
        pixels[offset + 1] = row[x * 3 + 1];
        pixels[offset + 2] = row[x * 3 + 2];
        pixels[offset + 3] = 255;
      }
    }
  }
  return { width: layout.width, height: layout.height, pixels };
}

function byteView(value) {
  if (!(value instanceof Uint8Array)) throw new Error("PNG input must be a byte array");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function imageLayout(width, height, channels) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION
  )
    throw new Error(`PNG dimensions must be integers from 1 through ${MAX_DIMENSION}`);
  if (width * height * 4 > MAX_PIXEL_BYTES) throw new Error("PNG exceeds the decoded pixel budget");
  const rowBytes = width * channels;
  return {
    width,
    height,
    channels,
    rowBytes,
    pixelBytes: rowBytes * height,
    stride: rowBytes + 1,
    filteredBytes: (rowBytes + 1) * height,
  };
}

function decodeHeader(data) {
  if (data.length !== 13) throw new Error("PNG IHDR must contain 13 bytes");
  if (data[8] !== 8 || ![2, 6].includes(data[9]))
    throw new Error("Only 8-bit RGB and RGBA PNG images are supported");
  if (data[10] !== 0 || data[11] !== 0)
    throw new Error("Unsupported PNG compression or filter method");
  if (data[12] !== 0) throw new Error("Interlaced PNG images are unsupported");
  return imageLayout(data.readUInt32BE(0), data.readUInt32BE(4), data[9] === 6 ? 4 : 3);
}

function unfilter(rows, layout) {
  for (let y = 0; y < layout.height; y += 1) {
    const start = y * layout.stride + 1;
    const filter = rows[start - 1];
    if (filter > 4) throw new Error(`Unsupported PNG row filter ${filter}`);
    for (let x = 0; x < layout.rowBytes; x += 1) {
      const offset = start + x;
      const left = x >= layout.channels ? rows[offset - layout.channels] : 0;
      const above = y > 0 ? rows[offset - layout.stride] : 0;
      const upperLeft =
        y > 0 && x >= layout.channels ? rows[offset - layout.stride - layout.channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      rows[offset] = (rows[offset] + predictor) & 255;
    }
  }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceDiagonal = Math.abs(estimate - upperLeft);
  return distanceLeft <= distanceAbove && distanceLeft <= distanceDiagonal
    ? left
    : distanceAbove <= distanceDiagonal
      ? above
      : upperLeft;
}

function chunk(type, data) {
  const output = Buffer.allocUnsafe(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, data.length + 8)), data.length + 8);
  return output;
}
