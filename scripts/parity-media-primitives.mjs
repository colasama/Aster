import { deflateSync } from "node:zlib";

export const MEDIA_WIDTH = 96;
export const MEDIA_HEIGHT = 64;

/** Seven large binary cells survive YUV420 subsampling and identify every source frame. */
export function rgbaFrame(frame) {
  const bytes = Buffer.alloc(MEDIA_WIDTH * MEDIA_HEIGHT * 4);
  for (let y = 0; y < MEDIA_HEIGHT; y += 1) {
    for (let x = 0; x < MEDIA_WIDTH; x += 1) {
      const offset = (y * MEDIA_WIDTH + x) * 4;
      const cell = Math.floor((x - 6) / 12);
      const barcode = y >= 8 && y < 32 && cell >= 0 && cell < 7;
      const value = (frame & (1 << cell)) === 0 ? 16 : 240;
      bytes[offset] = barcode ? value : (x * 2 + frame * 3) % 256;
      bytes[offset + 1] = barcode ? value : (y * 3 + frame * 5) % 256;
      bytes[offset + 2] = barcode ? value : (x + y + frame * 7) % 256;
      bytes[offset + 3] = y >= 48 ? Math.round(((x + 1) * 255) / MEDIA_WIDTH) : 255;
    }
  }
  return bytes;
}

export function decodeFrameIdentity(rgb) {
  let frame = 0;
  for (let bit = 0; bit < 7; bit += 1) {
    const offset = (20 * MEDIA_WIDTH + 12 + bit * 12) * 3;
    if ((rgb[offset] + rgb[offset + 1] + rgb[offset + 2]) / 3 > 128) frame |= 1 << bit;
  }
  return frame;
}

export function pngFrame(frame) {
  const rgba = rgbaFrame(frame);
  const scanlines = Buffer.alloc((MEDIA_WIDTH * 4 + 1) * MEDIA_HEIGHT);
  for (let y = 0; y < MEDIA_HEIGHT; y += 1)
    rgba.copy(
      scanlines,
      y * (MEDIA_WIDTH * 4 + 1) + 1,
      y * MEDIA_WIDTH * 4,
      (y + 1) * MEDIA_WIDTH * 4,
    );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(MEDIA_WIDTH, 0);
  header.writeUInt32BE(MEDIA_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

/** PCM16 stereo has distinct tones and amplitude steps for audio-analysis fixtures. */
export function wavAudio() {
  const sampleRate = 48_000;
  const sampleCount = sampleRate * 2;
  const pcm = Buffer.alloc(sampleCount * 4);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const amplitude = Math.floor(sample / 6_000) % 2 === 0 ? 12_000 : 3_000;
    pcm.writeInt16LE(
      Math.round(Math.sin((sample * Math.PI * 2 * 440) / sampleRate) * amplitude),
      sample * 4,
    );
    pcm.writeInt16LE(
      Math.round(Math.sin((sample * Math.PI * 2 * 660) / sampleRate) * amplitude),
      sample * 4 + 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** A raw four-channel PSD with one visible, non-group layer and its merged composite. */
export function psdImage() {
  const pixels = rgbaFrame(42);
  const planes = [0, 1, 2, 3].map((channel) => {
    const plane = Buffer.alloc(MEDIA_WIDTH * MEDIA_HEIGHT);
    for (let pixel = 0; pixel < plane.length; pixel += 1)
      plane[pixel] = pixels[pixel * 4 + channel];
    return plane;
  });
  const writer = new BigEndianWriter();
  writer.ascii("8BPS").u16(1).zeros(6).u16(4).u32(MEDIA_HEIGHT).u32(MEDIA_WIDTH).u16(8).u16(3);
  writer.u32(0).u32(0);
  const maskLength = writer.reserve();
  const maskStart = writer.length;
  const infoLength = writer.reserve();
  const infoStart = writer.length;
  writer.u16(0xffff).u32(0).u32(0).u32(MEDIA_HEIGHT).u32(MEDIA_WIDTH).u16(4);
  for (const channel of [0, 1, 2, 0xffff]) writer.u16(channel).u32(MEDIA_WIDTH * MEDIA_HEIGHT + 2);
  writer.ascii("8BIMnorm").bytes([255, 0, 0, 0]);
  const extraLength = writer.reserve();
  const extraStart = writer.length;
  writer.u32(0).u32(0).bytes([7]).ascii("Pattern");
  writer.ascii("8BIMlyid").u32(4).u32(42);
  writer.patch(extraLength, writer.length - extraStart);
  for (const plane of planes) writer.u16(0).bytes(plane);
  writer.patch(infoLength, writer.length - infoStart);
  writer.u32(0);
  writer.patch(maskLength, writer.length - maskStart);
  writer.u16(0);
  for (const plane of planes) writer.bytes(plane);
  return Buffer.from(writer.values);
}

class BigEndianWriter {
  values = [];

  get length() {
    return this.values.length;
  }

  bytes(values) {
    this.values.push(...values);
    return this;
  }

  ascii(value) {
    return this.bytes(Buffer.from(value, "ascii"));
  }

  zeros(count) {
    return this.bytes(Buffer.alloc(count));
  }

  u16(value) {
    return this.bytes([(value >>> 8) & 255, value & 255]);
  }

  u32(value) {
    return this.bytes([
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ]);
  }

  reserve() {
    const offset = this.length;
    this.u32(0);
    return offset;
  }

  patch(offset, value) {
    this.values.splice(
      offset,
      4,
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    );
  }
}
