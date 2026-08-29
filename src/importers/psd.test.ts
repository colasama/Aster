import { describe, expect, it } from "vitest";
import { decodePackBitsRow, parsePsd } from "./psd";

describe("PSD importer", () => {
  it("decodes PackBits literal, repeat, and no-op packets", () => {
    expect([...decodePackBitsRow(new Uint8Array([2, 10, 20, 30]), 3)]).toEqual([10, 20, 30]);
    expect([...decodePackBitsRow(new Uint8Array([254, 7]), 3)]).toEqual([7, 7, 7]);
    expect([...decodePackBitsRow(new Uint8Array([128, 0, 9]), 1)]).toEqual([9]);
    expect(() => decodePackBitsRow(new Uint8Array([3, 1]), 4)).toThrow("literal run");
  });

  it("parses a raw RGB PSD layer and composite with layer metadata", () => {
    const document = parsePsd(minimalPsd());
    expect(document).toMatchObject({
      width: 2,
      height: 1,
      channelCount: 3,
      depth: 8,
      colorMode: "rgb",
      mergedAlpha: false,
    });
    expect(document.layers).toHaveLength(1);
    expect(document.layers[0]).toMatchObject({
      id: 42,
      name: "Red Green",
      width: 2,
      height: 1,
      opacity: 1,
      visible: true,
      blendMode: "norm",
      sectionType: "openFolder",
    });
    expect(Array.from(document.layers[0]?.pixels ?? [])).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
    expect(Array.from(document.composite ?? [])).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("rejects unsupported depth, color mode, compression, and truncated sections", () => {
    const depth = minimalPsd();
    new DataView(depth).setUint16(22, 32, false);
    expect(() => parsePsd(depth)).toThrow("8 or 16");
    const color = minimalPsd();
    new DataView(color).setUint16(24, 4, false);
    expect(() => parsePsd(color)).toThrow("Grayscale or RGB");
    const compression = minimalPsd();
    new DataView(compression).setUint16(compression.byteLength - 8, 2, false);
    expect(() => parsePsd(compression)).toThrow("compression 2");
    expect(() => parsePsd(minimalPsd().slice(0, 40))).toThrow("truncated");
  });
});

function minimalPsd(): ArrayBuffer {
  const writer = new BinaryWriter();
  writer.ascii("8BPS").u16(1).zero(6).u16(3).u32(1).u32(2).u16(8).u16(3);
  writer.u32(0).u32(0);
  const layerMaskLength = writer.reserveU32();
  const layerMaskStart = writer.length;
  const layerInfoLength = writer.reserveU32();
  const layerInfoStart = writer.length;
  writer.i16(1);
  writer.i32(0).i32(0).i32(1).i32(2).u16(4);
  for (const id of [0, 1, 2, -1]) writer.i16(id).u32(4);
  writer.ascii("8BIM").ascii("norm").u8(255).u8(0).u8(0).u8(0);
  const extraLength = writer.reserveU32();
  const extraStart = writer.length;
  writer.u32(0).u32(0);
  writer.u8(2).ascii("RG").u8(0);
  writer.ascii("8BIM").ascii("luni");
  const unicodeLength = writer.reserveU32();
  const unicodeStart = writer.length;
  writer.u32(9);
  for (const character of "Red Green") writer.u16(character.charCodeAt(0));
  writer.patchU32(unicodeLength, writer.length - unicodeStart);
  writer.ascii("8BIM").ascii("lyid").u32(4).u32(42);
  writer.ascii("8BIM").ascii("lsct").u32(4).u32(1);
  writer.patchU32(extraLength, writer.length - extraStart);
  for (const plane of [
    [255, 0],
    [0, 255],
    [0, 0],
    [255, 128],
  ])
    writer.u16(0).bytes(plane);
  writer.patchU32(layerInfoLength, writer.length - layerInfoStart);
  writer.patchU32(layerMaskLength, writer.length - layerMaskStart);
  writer.u16(0).bytes([255, 0]).bytes([0, 255]).bytes([0, 0]);
  return writer.buffer();
}

class BinaryWriter {
  readonly values: number[] = [];

  get length(): number {
    return this.values.length;
  }

  ascii(value: string): this {
    return this.bytes([...value].map((character) => character.charCodeAt(0)));
  }

  bytes(values: readonly number[]): this {
    this.values.push(...values);
    return this;
  }

  zero(count: number): this {
    return this.bytes(Array.from({ length: count }, () => 0));
  }

  u8(value: number): this {
    this.values.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    const unsigned = value & 0xffff;
    return this.bytes([unsigned >>> 8, unsigned]);
  }

  i16(value: number): this {
    return this.u16(value);
  }

  u32(value: number): this {
    return this.bytes([value >>> 24, value >>> 16, value >>> 8, value]);
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  reserveU32(): number {
    const offset = this.length;
    this.u32(0);
    return offset;
  }

  patchU32(offset: number, value: number): void {
    this.values[offset] = (value >>> 24) & 0xff;
    this.values[offset + 1] = (value >>> 16) & 0xff;
    this.values[offset + 2] = (value >>> 8) & 0xff;
    this.values[offset + 3] = value & 0xff;
  }

  buffer(): ArrayBuffer {
    return new Uint8Array(this.values).buffer;
  }
}
