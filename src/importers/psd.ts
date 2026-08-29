import { inflatePsdZipData } from "./psd-zip";

export interface PsdRectangle {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface ParsedPsdLayer {
  id?: number;
  name: string;
  rectangle: PsdRectangle;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  blendMode: string;
  sectionType?: "openFolder" | "closedFolder" | "sectionDivider";
  pixels: Uint8ClampedArray;
}

export interface ParsedPsdDocument {
  width: number;
  height: number;
  channelCount: number;
  depth: 8 | 16;
  colorMode: "grayscale" | "rgb";
  mergedAlpha: boolean;
  layers: readonly ParsedPsdLayer[];
  composite?: Uint8ClampedArray;
}

interface ChannelRecord {
  id: number;
  length: number;
}

interface LayerRecord {
  id?: number;
  name: string;
  rectangle: PsdRectangle;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  blendMode: string;
  sectionType?: ParsedPsdLayer["sectionType"];
  channels: readonly ChannelRecord[];
}

const MAX_PSD_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 30_000;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_CHANNELS = 56;
const SIGNATURE = "8BPS";

/** Decodes bounded 8/16-bit RGB or grayscale PSD layers with Raw, PackBits, or ZIP compression. */
export async function parsePsd(buffer: ArrayBuffer): Promise<ParsedPsdDocument> {
  if (buffer.byteLength < 30 || buffer.byteLength > MAX_PSD_BYTES)
    throw new Error("PSD file is truncated or exceeds 512 MiB");
  const reader = new PsdReader(buffer);
  if (reader.ascii(4) !== SIGNATURE) throw new Error("PSD signature is invalid");
  if (reader.u16() !== 1) throw new Error("Only PSD version 1 is supported");
  reader.skip(6);
  const channelCount = reader.u16();
  const height = boundedDimension(reader.u32(), "height");
  const width = boundedDimension(reader.u32(), "width");
  const rawDepth = reader.u16();
  if (rawDepth !== 8 && rawDepth !== 16)
    throw new Error("PSD depth must be 8 or 16 bits per channel");
  const depth = rawDepth as 8 | 16;
  const rawColorMode = reader.u16();
  if (rawColorMode !== 1 && rawColorMode !== 3)
    throw new Error("PSD color mode must be Grayscale or RGB");
  const colorMode = rawColorMode === 1 ? "grayscale" : "rgb";
  const baseChannelCount = colorMode === "rgb" ? 3 : 1;
  if (channelCount < baseChannelCount || channelCount > MAX_CHANNELS)
    throw new Error(`PSD channel count must be between ${baseChannelCount} and ${MAX_CHANNELS}`);
  skipLengthSection(reader, "color mode data");
  skipLengthSection(reader, "image resources");
  const layerMaskLength = reader.u32();
  const layerMaskEnd = reader.offset + layerMaskLength;
  reader.require(layerMaskLength, "layer and mask information");
  let mergedAlpha = false;
  let layers: ParsedPsdLayer[] = [];
  if (layerMaskLength > 0) {
    const layerInfoLength = reader.u32();
    const layerInfoEnd = reader.offset + layerInfoLength;
    reader.require(layerInfoLength, "layer information");
    if (layerInfoLength > 0) {
      const signedLayerCount = reader.i16();
      mergedAlpha = signedLayerCount < 0;
      const layerCount = Math.abs(signedLayerCount);
      if (layerCount > 100_000) throw new Error("PSD layer count exceeds the supported limit");
      const records = Array.from({ length: layerCount }, () => readLayerRecord(reader));
      layers = await decodeLayers(reader, records, depth, colorMode);
    }
    reader.seek(layerInfoEnd, "layer information end");
  }
  reader.seek(layerMaskEnd, "layer and mask information end");
  const composite =
    reader.remaining >= 2
      ? await decodeComposite(reader, width, height, channelCount, depth, colorMode)
      : undefined;
  return { width, height, channelCount, depth, colorMode, mergedAlpha, layers, composite };
}

export function decodePackBitsRow(input: Uint8Array, expectedBytes: number): Uint8Array {
  const output = new Uint8Array(expectedBytes);
  let source = 0;
  let target = 0;
  while (source < input.length && target < expectedBytes) {
    const header = input[source] as number;
    source += 1;
    if (header <= 127) {
      const count = header + 1;
      if (source + count > input.length || target + count > expectedBytes)
        throw new Error("PSD PackBits literal run exceeds its row");
      output.set(input.subarray(source, source + count), target);
      source += count;
      target += count;
    } else if (header >= 129) {
      const count = 257 - header;
      if (source >= input.length || target + count > expectedBytes)
        throw new Error("PSD PackBits repeat run exceeds its row");
      output.fill(input[source] as number, target, target + count);
      source += 1;
      target += count;
    }
  }
  if (target !== expectedBytes) throw new Error("PSD PackBits row is incomplete");
  return output;
}

function readLayerRecord(reader: PsdReader): LayerRecord {
  const rectangle = {
    top: reader.i32(),
    left: reader.i32(),
    bottom: reader.i32(),
    right: reader.i32(),
  };
  const width = Math.max(0, rectangle.right - rectangle.left);
  const height = Math.max(0, rectangle.bottom - rectangle.top);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION)
    throw new Error("PSD layer dimensions exceed the supported limit");
  const channelCount = reader.u16();
  if (channelCount > 64) throw new Error("PSD layer channel count exceeds the supported limit");
  const channels = Array.from({ length: channelCount }, () => ({
    id: reader.i16(),
    length: reader.u32(),
  }));
  if (reader.ascii(4) !== "8BIM") throw new Error("PSD layer blend signature is invalid");
  const blendMode = reader.ascii(4);
  const opacity = reader.u8() / 255;
  reader.skip(1);
  const flags = reader.u8();
  reader.skip(1);
  const extraLength = reader.u32();
  const extraEnd = reader.offset + extraLength;
  reader.require(extraLength, "layer extra data");
  skipLengthSection(reader, "layer mask");
  skipLengthSection(reader, "layer blending ranges");
  const pascalLength = reader.u8();
  const pascalName = decodeLatin1(reader.bytes(pascalLength));
  reader.skip((4 - ((pascalLength + 1) % 4)) % 4);
  let name = pascalName || "Layer";
  let id: number | undefined;
  let sectionType: ParsedPsdLayer["sectionType"];
  while (reader.offset + 12 <= extraEnd) {
    const signature = reader.ascii(4);
    const key = reader.ascii(4);
    const length = reader.u32();
    if (signature !== "8BIM" && signature !== "8B64")
      throw new Error("PSD layer tagged-block signature is invalid");
    const dataEnd = reader.offset + length;
    reader.require(length, `layer tagged block ${key}`);
    if (key === "luni" && length >= 4) name = readUnicodeString(reader, dataEnd) || name;
    else if (key === "lyid" && length >= 4) id = reader.u32();
    else if (key === "lsct" && length >= 4) sectionType = layerSectionType(reader.u32());
    reader.seek(dataEnd, `layer tagged block ${key} end`);
    if (length % 2 === 1) reader.skip(1);
  }
  reader.seek(extraEnd, "layer extra data end");
  return {
    ...(id === undefined ? {} : { id }),
    name,
    rectangle,
    width,
    height,
    opacity,
    visible: (flags & 0x02) === 0,
    blendMode,
    ...(sectionType ? { sectionType } : {}),
    channels,
  };
}

function layerSectionType(value: number): ParsedPsdLayer["sectionType"] {
  if (value === 1) return "openFolder";
  if (value === 2) return "closedFolder";
  if (value === 3) return "sectionDivider";
  return undefined;
}

async function decodeLayers(
  reader: PsdReader,
  records: readonly LayerRecord[],
  depth: 8 | 16,
  colorMode: "grayscale" | "rgb",
): Promise<ParsedPsdLayer[]> {
  let decodedBytes = 0;
  const layers: ParsedPsdLayer[] = [];
  for (const record of records) {
    decodedBytes += checkedProduct(
      record.width,
      record.height,
      record.channels.length * (depth / 8) + 4,
    );
    if (decodedBytes > MAX_DECODED_BYTES) throw new Error("PSD decoded layers exceed 512 MiB");
    const decoded = new Map<number, Uint8Array>();
    for (const channel of record.channels) {
      const channelEnd = reader.offset + channel.length;
      reader.require(channel.length, `layer ${record.name} channel ${channel.id}`);
      if (channel.length < 2) throw new Error("PSD layer channel is truncated");
      const compression = reader.u16();
      decoded.set(
        channel.id,
        await decodePlane(reader, record.width, record.height, depth, compression, channelEnd),
      );
      reader.seek(channelEnd, `layer ${record.name} channel end`);
    }
    layers.push({
      ...record,
      pixels: interleavePlanes(decoded, record.width, record.height, colorMode),
    });
  }
  return layers;
}

async function decodeComposite(
  reader: PsdReader,
  width: number,
  height: number,
  channelCount: number,
  depth: 8 | 16,
  colorMode: "grayscale" | "rgb",
): Promise<Uint8ClampedArray> {
  checkedProduct(width, height, channelCount * (depth / 8) + 4);
  const compression = reader.u16();
  const planes = new Map<number, Uint8Array>();
  if (compression === 0) {
    for (let channel = 0; channel < channelCount; channel += 1)
      planes.set(channel, decodeRawPlane(reader, width, height, depth));
  } else if (compression === 1) {
    const rowLengths = Array.from({ length: channelCount * height }, () => reader.u16());
    for (let channel = 0; channel < channelCount; channel += 1)
      planes.set(
        channel,
        decodeRleRows(
          reader,
          width,
          height,
          depth,
          rowLengths.slice(channel * height, (channel + 1) * height),
        ),
      );
  } else if (compression === 2 || compression === 3) {
    const inflated = await inflatePsdZipData(
      reader.bytes(reader.remaining),
      width,
      height * channelCount,
      depth,
      compression === 3,
    );
    const planeBytes = width * height * (depth / 8);
    for (let channel = 0; channel < channelCount; channel += 1)
      planes.set(
        channel,
        decodeRawPlaneBytes(
          inflated.subarray(channel * planeBytes, (channel + 1) * planeBytes),
          depth,
        ),
      );
  } else throw new Error(`PSD composite compression ${compression} is not supported`);
  if (colorMode === "rgb" && channelCount > 3) planes.set(-1, planes.get(3) as Uint8Array);
  else if (colorMode === "grayscale" && channelCount > 1)
    planes.set(-1, planes.get(1) as Uint8Array);
  return interleavePlanes(planes, width, height, colorMode);
}

async function decodePlane(
  reader: PsdReader,
  width: number,
  height: number,
  depth: 8 | 16,
  compression: number,
  channelEnd: number,
): Promise<Uint8Array> {
  if (width === 0 || height === 0) return new Uint8Array();
  if (compression === 0) return decodeRawPlane(reader, width, height, depth);
  if (compression === 1) {
    const rowLengths = Array.from({ length: height }, () => reader.u16());
    const plane = decodeRleRows(reader, width, height, depth, rowLengths);
    if (reader.offset > channelEnd) throw new Error("PSD RLE channel exceeds its declared length");
    return plane;
  }
  if (compression === 2 || compression === 3) {
    const inflated = await inflatePsdZipData(
      reader.bytes(channelEnd - reader.offset),
      width,
      height,
      depth,
      compression === 3,
    );
    return decodeRawPlaneBytes(inflated, depth);
  }
  throw new Error(`PSD layer compression ${compression} is not supported`);
}

function decodeRawPlane(
  reader: PsdReader,
  width: number,
  height: number,
  depth: 8 | 16,
): Uint8Array {
  const pixelCount = checkedProduct(width, height, 1);
  const source = reader.bytes(pixelCount * (depth / 8));
  return decodeRawPlaneBytes(source, depth);
}

function decodeRawPlaneBytes(source: Uint8Array, depth: 8 | 16): Uint8Array {
  if (depth === 8) return source.slice();
  const output = new Uint8Array(source.length / 2);
  for (let index = 0; index < output.length; index += 1)
    output[index] = source[index * 2] as number;
  return output;
}

function decodeRleRows(
  reader: PsdReader,
  width: number,
  height: number,
  depth: 8 | 16,
  rowLengths: readonly number[],
): Uint8Array {
  const bytesPerRow = width * (depth / 8);
  const output = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const packed = reader.bytes(rowLengths[row] ?? 0);
    const decoded = decodePackBitsRow(packed, bytesPerRow);
    if (depth === 8) output.set(decoded, row * width);
    else
      for (let column = 0; column < width; column += 1)
        output[row * width + column] = decoded[column * 2] as number;
  }
  return output;
}

function interleavePlanes(
  planes: ReadonlyMap<number, Uint8Array>,
  width: number,
  height: number,
  colorMode: "grayscale" | "rgb",
): Uint8ClampedArray {
  const pixelCount = checkedProduct(width, height, 1);
  const output = new Uint8ClampedArray(pixelCount * 4);
  const alpha = planes.get(-1);
  const grayscale = planes.get(0);
  const red = colorMode === "rgb" ? planes.get(0) : grayscale;
  const green = colorMode === "rgb" ? planes.get(1) : grayscale;
  const blue = colorMode === "rgb" ? planes.get(2) : grayscale;
  for (let index = 0; index < pixelCount; index += 1) {
    output[index * 4] = red?.[index] ?? 0;
    output[index * 4 + 1] = green?.[index] ?? 0;
    output[index * 4 + 2] = blue?.[index] ?? 0;
    output[index * 4 + 3] = alpha?.[index] ?? 255;
  }
  return output;
}

function skipLengthSection(reader: PsdReader, name: string): void {
  const length = reader.u32();
  reader.require(length, name);
  reader.skip(length);
}

function readUnicodeString(reader: PsdReader, end: number): string {
  const count = reader.u32();
  if (count > 1_000_000 || reader.offset + count * 2 > end)
    throw new Error("PSD Unicode layer name is invalid");
  let value = "";
  for (let offset = 0; offset < count; offset += 0x8000) {
    const chunkLength = Math.min(0x8000, count - offset);
    const units = Array.from({ length: chunkLength }, () => reader.u16());
    value += String.fromCharCode(...units);
  }
  return value.replace(/\0+$/g, "");
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("windows-1252").decode(bytes).replace(/\0+$/g, "");
}

function boundedDimension(value: number, name: string): number {
  if (value < 1 || value > MAX_DIMENSION)
    throw new Error(`PSD ${name} exceeds the supported limit`);
  return value;
}

function checkedProduct(left: number, right: number, multiplier: number): number {
  const product = left * right * multiplier;
  if (!Number.isSafeInteger(product) || product < 0 || product > MAX_DECODED_BYTES)
    throw new Error("PSD decoded pixel budget is exceeded");
  return product;
}

class PsdReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.#bytes = new Uint8Array(buffer);
    this.#view = new DataView(buffer);
  }

  get remaining(): number {
    return this.#bytes.length - this.offset;
  }

  require(length: number, name: string): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.#bytes.length)
      throw new Error(`PSD ${name} is truncated`);
  }

  seek(offset: number, name: string): void {
    if (!Number.isSafeInteger(offset) || offset < this.offset || offset > this.#bytes.length)
      throw new Error(`PSD ${name} offset is invalid`);
    this.offset = offset;
  }

  skip(length: number): void {
    this.require(length, "section");
    this.offset += length;
  }

  bytes(length: number): Uint8Array {
    this.require(length, "data");
    const value = this.#bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  ascii(length: number): string {
    return String.fromCharCode(...this.bytes(length));
  }

  u8(): number {
    this.require(1, "byte");
    const value = this.#view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.require(2, "uint16");
    const value = this.#view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.require(2, "int16");
    const value = this.#view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4, "uint32");
    const value = this.#view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4, "int32");
    const value = this.#view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }
}
