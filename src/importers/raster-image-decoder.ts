import { isTiffSource } from "./tiff-source";

export interface RasterImageIdentity {
  name?: string;
  mimeType?: string;
}

interface DecodedRasterImage {
  width: number;
  height: number;
  pixels?: ArrayBuffer;
}

interface WorkerDecodeResponse extends DecodedRasterImage {
  id: number;
  ok: true;
}

interface WorkerDecodeFailure {
  id: number;
  ok: false;
  message: string;
}

type PendingWorkerDecode = {
  resolve: (value: DecodedRasterImage) => void;
  reject: (reason: Error) => void;
};

let decoderWorker: Worker | undefined;
let nextRequestId = 1;
const pendingWorkerDecodes = new Map<number, PendingWorkerDecode>();

export async function readRasterImageMetadata(
  blob: Blob,
  identity: RasterImageIdentity = {},
): Promise<{ width: number; height: number }> {
  if (isTiffSource(identity.name, identity.mimeType || blob.type)) {
    const decoded = await decodeTiff(await blob.arrayBuffer(), false);
    return { width: decoded.width, height: decoded.height };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export function decodeRasterImage(
  blob: Blob,
  identity: RasterImageIdentity = {},
): Promise<ImageBitmap> {
  if (!isTiffSource(identity.name, identity.mimeType || blob.type)) return createImageBitmap(blob);
  return decodeTiffBitmap(blob);
}

async function decodeTiffBitmap(blob: Blob): Promise<ImageBitmap> {
  const decoded = await decodeTiff(await blob.arrayBuffer(), true);
  if (!decoded.pixels) throw new Error("TIFF decoder returned no pixel plane");
  const pixels = new Uint8ClampedArray(decoded.pixels);
  return createImageBitmap(new ImageData(pixels, decoded.width, decoded.height), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
}

async function decodeTiff(bytes: ArrayBuffer, includePixels: boolean): Promise<DecodedRasterImage> {
  if (typeof Worker !== "function") {
    const { decodeTiffRgba } = await import("./tiff-decoder");
    const decoded = decodeTiffRgba(bytes);
    return {
      width: decoded.width,
      height: decoded.height,
      ...(includePixels ? { pixels: exactArrayBuffer(decoded.pixels) } : {}),
    };
  }
  const worker = getDecoderWorker();
  const id = nextRequestId++;
  const pending = new Promise<DecodedRasterImage>((resolve, reject) => {
    pendingWorkerDecodes.set(id, { resolve, reject });
  });
  try {
    worker.postMessage({ id, bytes, includePixels }, [bytes]);
  } catch (error) {
    const rejected = pendingWorkerDecodes.get(id);
    pendingWorkerDecodes.delete(id);
    rejected?.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return pending;
}

function getDecoderWorker(): Worker {
  if (decoderWorker) return decoderWorker;
  const worker = new Worker(new URL("./tiff-decoder.worker.ts", import.meta.url), {
    name: "aster-tiff-decoder",
    type: "module",
  });
  worker.addEventListener(
    "message",
    (event: MessageEvent<WorkerDecodeResponse | WorkerDecodeFailure>) => {
      const response = event.data;
      const pending = pendingWorkerDecodes.get(response.id);
      if (!pending) return;
      pendingWorkerDecodes.delete(response.id);
      if (response.ok) pending.resolve(response);
      else pending.reject(new Error(response.message));
    },
  );
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "TIFF decoder worker failed");
    for (const pending of pendingWorkerDecodes.values()) pending.reject(error);
    pendingWorkerDecodes.clear();
    worker.terminate();
    if (decoderWorker === worker) decoderWorker = undefined;
  });
  decoderWorker = worker;
  return worker;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
