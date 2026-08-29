const MAX_INFLATED_PSD_BYTES = 512 * 1024 * 1024;

/** Streams bounded zlib data and reverses Photoshop's per-row ZIP predictor when requested. */
export async function inflatePsdZipData(
  compressed: Uint8Array,
  width: number,
  rowCount: number,
  depth: 8 | 16,
  prediction: boolean,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function")
    throw new Error("PSD ZIP decompression is unavailable in this renderer");
  const bytesPerSample = depth / 8;
  const expectedBytes = checkedSize(width, rowCount, bytesPerSample);
  const output = new Uint8Array(expectedBytes);
  const stream = new Blob([compressed.slice().buffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > expectedBytes) {
        await reader.cancel("PSD ZIP data exceeds its declared plane size");
        throw new Error("PSD ZIP data exceeds its declared plane size");
      }
      output.set(value, offset);
      offset += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error("PSD ZIP data is truncated");
  if (prediction) reversePrediction(output, width, rowCount, depth);
  return output;
}

function reversePrediction(data: Uint8Array, width: number, rowCount: number, depth: 8 | 16): void {
  const rowBytes = width * (depth / 8);
  for (let row = 0; row < rowCount; row += 1) {
    const start = row * rowBytes;
    if (depth === 8) {
      for (let column = 1; column < width; column += 1) {
        const index = start + column;
        data[index] = ((data[index] ?? 0) + (data[index - 1] ?? 0)) & 0xff;
      }
      continue;
    }
    let previous = ((data[start] ?? 0) << 8) | (data[start + 1] ?? 0);
    for (let column = 1; column < width; column += 1) {
      const index = start + column * 2;
      const delta = ((data[index] ?? 0) << 8) | (data[index + 1] ?? 0);
      const value = (previous + delta) & 0xffff;
      data[index] = value >>> 8;
      data[index + 1] = value & 0xff;
      previous = value;
    }
  }
}

function checkedSize(width: number, rowCount: number, bytesPerSample: number): number {
  const size = width * rowCount * bytesPerSample;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_INFLATED_PSD_BYTES)
    throw new Error("PSD ZIP output exceeds the 512 MiB decode budget");
  return size;
}
