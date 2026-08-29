import { describe, expect, it } from "vitest";
import { inflatePsdZipData } from "./psd-zip";

describe("PSD ZIP channel decoding", () => {
  it("inflates bounded ZIP data without prediction", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const compressed = await deflate(source);
    expect(await inflatePsdZipData(compressed, 3, 2, 8, false)).toEqual(source);
  });

  it("reverses 8-bit row prediction independently per scanline", async () => {
    const predicted = new Uint8Array([10, 10, 10, 5, 2, 2]);
    const compressed = await deflate(predicted);
    expect(await inflatePsdZipData(compressed, 3, 2, 8, true)).toEqual(
      new Uint8Array([10, 20, 30, 5, 7, 9]),
    );
  });

  it("reverses big-endian 16-bit sample prediction", async () => {
    const predicted = words([0x0102, 0x0202, 0x0202, 0x1000, 0x0002, 0x0003]);
    const compressed = await deflate(predicted);
    expect(await inflatePsdZipData(compressed, 3, 2, 16, true)).toEqual(
      words([0x0102, 0x0304, 0x0506, 0x1000, 0x1002, 0x1005]),
    );
  });

  it("rejects inflated data that differs from the declared plane size", async () => {
    const compressed = await deflate(new Uint8Array([1, 2, 3]));
    await expect(inflatePsdZipData(compressed, 2, 1, 8, false)).rejects.toThrow("exceeds");
    await expect(inflatePsdZipData(compressed, 4, 1, 8, false)).rejects.toThrow("truncated");
  });
});

async function deflate(source: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([source.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function words(values: readonly number[]): Uint8Array {
  return new Uint8Array(values.flatMap((value) => [value >>> 8, value & 0xff]));
}
