import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { decodeRgbaPng, encodeRgbaPng } from "./png.mjs";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function header(width = 1, height = 1, colorType = 6) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width, 0);
  bytes.writeUInt32BE(height, 4);
  bytes[8] = 8;
  bytes[9] = colorType;
  return bytes;
}

function fixture({
  width = 1,
  height = 1,
  colorType = 6,
  rows = [0, 20, 30, 40, 50],
  ihdr = header(width, height, colorType),
  data = deflateSync(Buffer.from(rows)),
  before = [],
  after = [],
} = {}) {
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    ...before,
    chunk("IDAT", data),
    ...after,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("RGBA roundtrip preserves every alpha and hidden RGB code value without premultiplication", () => {
  const pixels = Buffer.alloc(256 * 4 * 2);
  for (let value = 0; value < 256; value += 1) {
    pixels.set([value, 255 - value, (value * 17) & 255, value], value * 4);
    pixels.set([value, 255 - value, (value * 29) & 255, 0], (256 + value) * 4);
  }
  const original = Buffer.from(pixels);
  const encoded = encodeRgbaPng(256, 2, pixels);
  assert.deepEqual(decodeRgbaPng(encoded), { width: 256, height: 2, pixels: original });
  assert.deepEqual(pixels, original);
  assert.deepEqual(encodeRgbaPng(256, 2, pixels), encoded);
});

test("respects byte-view offsets for input pixels and encoded PNG", () => {
  const storage = Uint8Array.from([1, 2, 21, 22, 23, 0, 7, 8]);
  const encoded = encodeRgbaPng(1, 1, storage.subarray(2, 6));
  const wrapped = Buffer.concat([Buffer.from([1, 2]), encoded, Buffer.from([3])]);
  assert.deepEqual(decodeRgbaPng(wrapped.subarray(2, -1)).pixels, Buffer.from([21, 22, 23, 0]));
});

const expectedRgb = [5, 7, 11, 13, 17, 19, 23, 29, 31, 3, 11, 9, 19, 13, 23, 29, 31, 41];
const filteredRows = [
  [
    [5, 7, 11, 13, 17, 19, 23, 29, 31],
    [3, 11, 9, 19, 13, 23, 29, 31, 41],
  ],
  [
    [5, 7, 11, 8, 10, 8, 10, 12, 12],
    [3, 11, 9, 16, 2, 14, 10, 18, 18],
  ],
  [
    [5, 7, 11, 13, 17, 19, 23, 29, 31],
    [254, 4, 254, 6, 252, 4, 6, 2, 10],
  ],
  [
    [5, 7, 11, 11, 14, 14, 17, 21, 22],
    [1, 8, 4, 11, 255, 9, 8, 10, 14],
  ],
  [
    [5, 7, 11, 8, 10, 8, 10, 12, 12],
    [254, 4, 254, 6, 252, 4, 6, 2, 10],
  ],
];

for (const [filter, rows] of filteredRows.entries()) {
  test(`decodes RGB PNG row filter ${filter} with opaque alpha and wrapped residuals`, () => {
    const png = fixture({
      width: 3,
      height: 2,
      colorType: 2,
      rows: rows.flatMap((row) => [filter, ...row]),
    });
    const expected = Buffer.from(
      expectedRgb.flatMap((value, index) => (index % 3 === 2 ? [value, 255] : [value])),
    );
    assert.deepEqual(decodeRgbaPng(png), { width: 3, height: 2, pixels: expected });
  });
  test(`decodes RGBA PNG row filter ${filter} without discarding hidden RGB`, () => {
    const png = fixture({
      width: 3,
      height: 2,
      rows: rows.flatMap((row) => [
        filter,
        ...row.flatMap((value, index) => (index % 3 === 2 ? [value, 0] : [value])),
      ]),
    });
    const expected = Buffer.from(
      expectedRgb.flatMap((value, index) => (index % 3 === 2 ? [value, 0] : [value])),
    );
    assert.deepEqual(decodeRgbaPng(png), { width: 3, height: 2, pixels: expected });
  });
}

test("Paeth selects the upper-left predictor and handles RGBA channel stride", () => {
  const png = fixture({
    width: 2,
    height: 2,
    rows: [4, 100, 100, 100, 100, 50, 50, 50, 50, 4, 206, 206, 206, 206, 100, 100, 100, 100],
  });
  assert.deepEqual(
    decodeRgbaPng(png).pixels,
    Buffer.from([100, 100, 100, 100, 150, 150, 150, 150, 50, 50, 50, 50, 200, 200, 200, 200]),
  );
});

test("accepts consecutive IDAT chunks and ignores ancillary metadata without color conversion", () => {
  const compressed = deflateSync(Buffer.from([0, 200, 30, 50, 0]));
  const png = Buffer.concat([
    signature,
    chunk("IHDR", header()),
    chunk("gAMA", Buffer.from([0, 0, 177, 143])),
    chunk("IDAT", compressed.subarray(0, 3)),
    chunk("IDAT", Buffer.alloc(0)),
    chunk("IDAT", compressed.subarray(3)),
    chunk("tEXt", Buffer.from("Author\0Aster")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.deepEqual(decodeRgbaPng(png).pixels, Buffer.from([200, 30, 50, 0]));
});

test("rejects invalid signature, CRC and every truncated structure", () => {
  const png = fixture();
  const badSignature = Buffer.from(png);
  badSignature[0] = 0;
  assert.throws(() => decodeRgbaPng(badSignature), /signature/);
  const badCrc = Buffer.from(png);
  badCrc[29] ^= 1;
  assert.throws(() => decodeRgbaPng(badCrc), /CRC mismatch/);
  for (const end of [0, 7, 8, 15, 30, png.length - 1])
    assert.throws(() => decodeRgbaPng(png.subarray(0, end)), /PNG/);
  assert.throws(() => decodeRgbaPng(Buffer.concat([png, Buffer.from([0])])), /trailing data/);
});

test("rejects unsafe dimensions and decoded budgets before allocating pixels", () => {
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [32769, 1],
    [1, 32769],
    [8192, 8193],
    [0xffffffff, 0xffffffff],
  ])
    assert.throws(() => decodeRgbaPng(fixture({ width, height })), /dimensions|pixel budget/);
  for (const [width, height] of [
    [1.5, 1],
    [-1, 1],
    [1, Number.NaN],
    [32769, 1],
    [8192, 8193],
  ])
    assert.throws(() => encodeRgbaPng(width, height, Buffer.alloc(0)), /dimensions|pixel budget/);
  assert.throws(() => encodeRgbaPng(2, 1, Buffer.alloc(4)), /input length/);
  assert.throws(() => encodeRgbaPng(1, 1, [0, 0, 0, 0]), /byte array/);
  const hugeChunk = Buffer.concat([
    signature,
    Buffer.from([128, 0, 0, 0]),
    Buffer.from("IHDR"),
    Buffer.alloc(4),
  ]);
  assert.throws(() => decodeRgbaPng(hugeChunk), /chunk length/);
});

test("rejects unsupported bit depths, colors, interlace, transparency and animation", () => {
  for (const [field, value, expected] of [
    [8, 16, /8-bit/],
    [9, 0, /RGB/],
    [9, 3, /RGB/],
    [9, 4, /RGB/],
    [10, 1, /compression/],
    [11, 1, /filter method/],
    [12, 1, /Interlaced/],
  ]) {
    const ihdr = header();
    ihdr[field] = value;
    assert.throws(() => decodeRgbaPng(fixture({ ihdr })), expected);
  }
  assert.throws(
    () => decodeRgbaPng(fixture({ colorType: 2, before: [chunk("tRNS", Buffer.alloc(6))] })),
    /tRNS/,
  );
  assert.throws(
    () => decodeRgbaPng(fixture({ before: [chunk("acTL", Buffer.alloc(8))] })),
    /Animated/,
  );
});

test("rejects invalid chunk ordering, malformed chunks and unknown critical data", () => {
  assert.throws(() => decodeRgbaPng(fixture({ before: [chunk("IHDR", header())] })), /Duplicate/);
  assert.throws(() => decodeRgbaPng(fixture({ ihdr: header().subarray(0, 12) })), /13 bytes/);
  assert.throws(
    () => decodeRgbaPng(fixture({ before: [chunk("ABCD", Buffer.alloc(0))] })),
    /critical chunk/,
  );
  assert.throws(
    () => decodeRgbaPng(fixture({ before: [chunk("te1t", Buffer.alloc(0))] })),
    /chunk type/,
  );
  assert.throws(
    () => decodeRgbaPng(fixture({ before: [chunk("test", Buffer.alloc(0))] })),
    /chunk type/,
  );
  assert.throws(() => decodeRgbaPng(fixture({ before: [chunk("PLTE", Buffer.alloc(2))] })), /PLTE/);
  assert.throws(
    () =>
      decodeRgbaPng(
        fixture({
          after: [
            chunk("IDAT", Buffer.alloc(0)),
            chunk("tEXt", Buffer.from("a\0b")),
            chunk("IDAT", Buffer.alloc(0)),
          ],
        }),
      ),
    /consecutive/,
  );
  assert.throws(
    () =>
      decodeRgbaPng(
        Buffer.concat([signature, chunk("tEXt", Buffer.from("a\0b")), chunk("IHDR", header())]),
      ),
    /first chunk/,
  );
  assert.throws(
    () =>
      decodeRgbaPng(
        Buffer.concat([signature, chunk("IHDR", header()), chunk("IEND", Buffer.alloc(0))]),
      ),
    /no IDAT/,
  );
  assert.throws(
    () => decodeRgbaPng(fixture({ after: [chunk("IEND", Buffer.from([0]))] })),
    /IEND must be empty/,
  );
});

test("bounds decompression and rejects short data, invalid filters and trailing zlib streams", () => {
  assert.throws(
    () => decodeRgbaPng(fixture({ rows: new Array(10000).fill(0) })),
    /decompression budget/,
  );
  assert.throws(() => decodeRgbaPng(fixture({ rows: [0, 20, 30, 40] })), /decompressed length/);
  assert.throws(() => decodeRgbaPng(fixture({ rows: [5, 20, 30, 40, 50] })), /row filter 5/);
  assert.throws(() => decodeRgbaPng(fixture({ data: Buffer.from([0, 1, 2]) })), /invalid|budget/);
  const data = Buffer.concat([
    deflateSync(Buffer.from([0, 20, 30, 40, 50])),
    deflateSync(Buffer.from([1])),
  ]);
  assert.throws(() => decodeRgbaPng(fixture({ data })), /trailing compressed data/);
});
